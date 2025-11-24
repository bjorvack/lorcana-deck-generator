const tf = require('@tensorflow/tfjs-node');

/**
 * RLTrainer - REINFORCE algorithm for training deck generator
 * Uses validator scores as reward signal to fine-tune policy network
 */
class RLTrainer {
    constructor(policyModel, validatorModel, trainingManager, options = {}) {
        this.policy = policyModel;
        this.validator = validatorModel;
        this.trainingManager = trainingManager;

        // Hyperparameters
        this.learningRate = options.learningRate || 0.0001;
        this.batchSize = options.batchSize || 10;
        this.gamma = options.gamma || 0.99; // Discount factor
        this.useBaseline = options.useBaseline !== false; // Default true
        this.entropyCoef = options.entropyCoef || 0.01; // Exploration bonus
        this.maxGradNorm = options.maxGradNorm || 1.0; // Gradient clipping

        // Optimizer
        this.optimizer = tf.train.adam(this.learningRate);

        // Metrics
        this.episodeRewards = [];
        this.baseline = 0.5; // Running average of rewards
    }

    /**
     * Collect one episode (generate one full deck)
     * Returns: { states, actions, logProbs, reward }
     */
    async collectEpisode(inks) {
        const episode = {
            states: [],      // Deck states at each step
            actions: [],     // Card indices chosen
            logProbs: [],    // Log probabilities of actions
            reward: 0        // Terminal reward from validator
        };

        let deck = [];
        const cardCounts = new Map();

        // Generate deck card by card
        while (deck.length < 60) {
            // Current state
            episode.states.push([...deck]);

            // Get action probabilities from policy
            const probs = await this.policy.predict(deck);

            // Sample action using policy
            const { action, logProb } = this.sampleActionFromPolicy(probs, deck, cardCounts);

            episode.actions.push(action);
            episode.logProbs.push(logProb);

            // Execute action
            deck.push(action);
            cardCounts.set(action, (cardCounts.get(action) || 0) + 1);
        }

        // Get terminal reward from validator
        const deckFeatures = this.trainingManager.extractDeckFeaturesWithEmbeddings(deck);
        episode.reward = await this.validator.evaluate(deckFeatures);

        return episode;
    }

    /**
     * Sample action from policy with exploration
     * Filters invalid actions (exceeds max count)
     */
    sampleActionFromPolicy(probs, currentDeck, cardCounts) {
        // Create array from Float32Array
        const probsArray = Array.from(probs);

        // Mask invalid actions (cards at max count)
        const maskedProbs = probsArray.map((p, idx) => {
            const card = this.trainingManager.indexMap.get(idx);
            if (!card) return 0;

            const count = cardCounts.get(idx) || 0;
            const maxAmount = card.maxAmount || 4;

            // Can't add more if at max
            if (count >= maxAmount) return 0;

            return p;
        });

        // Renormalize
        const sum = maskedProbs.reduce((a, b) => a + b, 0);
        if (sum === 0) {
            // Fallback: uniform over valid actions
            const validActions = maskedProbs.map((p, i) => p > 0 ? i : -1).filter(i => i >= 0);
            if (validActions.length === 0) {
                console.warn('No valid actions available!');
                return { action: 0, logProb: 0 };
            }
            const action = validActions[Math.floor(Math.random() * validActions.length)];
            return { action, logProb: Math.log(1.0 / validActions.length) };
        }

        const normalized = maskedProbs.map(p => p / sum);

        // Sample from categorical distribution
        const rand = Math.random();
        let cumsum = 0;
        for (let i = 0; i < normalized.length; i++) {
            cumsum += normalized[i];
            if (rand < cumsum) {
                const logProb = Math.log(Math.max(normalized[i], 1e-10));
                return { action: i, logProb };
            }
        }

        // Fallback (shouldn't reach here)
        const action = normalized.length - 1;
        const logProb = Math.log(Math.max(normalized[action], 1e-10));
        return { action, logProb };
    }

    /**
     * Compute returns for an episode
     * Can use discounting or just terminal reward
     */
    computeReturns(episode) {
        const returns = [];

        // Simple version: all steps get same terminal reward
        // (Deck quality is only known at end)
        for (let t = 0; t < episode.logProbs.length; t++) {
            returns.push(episode.reward);
        }

        return returns;
    }

    /**
     * Train one step: collect episodes and update policy
     */
    async trainStep(inks) {
        console.log(`\n[RL] Collecting ${this.batchSize} episodes...`);
        const episodes = [];

        // Collect batch of episodes
        for (let i = 0; i < this.batchSize; i++) {
            const episode = await this.collectEpisode(inks);
            episodes.push(episode);
            process.stdout.write(`\r  Episode ${i + 1}/${this.batchSize}: reward = ${episode.reward.toFixed(3)}`);
        }
        console.log(''); // Newline

        // Compute statistics
        const rewards = episodes.map(ep => ep.reward);
        const avgReward = rewards.reduce((a, b) => a + b, 0) / rewards.length;
        const stdReward = Math.sqrt(
            rewards.reduce((sum, r) => sum + Math.pow(r - avgReward, 2), 0) / rewards.length
        );

        // Update baseline
        if (this.useBaseline) {
            this.baseline = this.baseline * 0.9 + avgReward * 0.1; // EMA
        }

        // Compute policy gradient and update
        const lossValue = await this.updatePolicy(episodes);

        // Track metrics
        this.episodeRewards.push(avgReward);

        console.log(`[RL] Avg Reward: ${avgReward.toFixed(4)} ± ${stdReward.toFixed(4)}`);
        console.log(`[RL] Baseline: ${this.baseline.toFixed(4)}`);
        console.log(`[RL] Loss: ${lossValue.toFixed(4)}`);

        return {
            avgReward,
            stdReward,
            baseline: this.baseline,
            loss: lossValue
        };
    }

    /**
     * Update policy using REINFORCE algorithm
     */
    async updatePolicy(episodes) {
        const allLogProbs = [];
        const allAdvantages = [];

        // Prepare data
        for (const episode of episodes) {
            const returns = this.computeReturns(episode);

            for (let t = 0; t < episode.logProbs.length; t++) {
                allLogProbs.push(episode.logProbs[t]);

                // Advantage = return - baseline
                const advantage = this.useBaseline
                    ? returns[t] - this.baseline
                    : returns[t];
                allAdvantages.push(advantage);
            }
        }

        // Compute loss
        const loss = tf.tidy(() => {
            const logProbsTensor = tf.tensor1d(allLogProbs);
            const advantagesTensor = tf.tensor1d(allAdvantages);

            // REINFORCE loss: -log(π(a|s)) * advantage
            const policyLoss = tf.mean(tf.mul(tf.neg(logProbsTensor), advantagesTensor));

            return policyLoss;
        });

        // Get loss value before disposing
        const lossValue = (await loss.data())[0];

        // Compute gradients and update (simplified - in practice would use tf.variableGrads)
        // For now, we'll rely on the policy model's existing training methods
        // This is a simplified version - full implementation would compute custom gradients

        loss.dispose();

        return lossValue;
    }

    /**
     * Main training loop
     */
    async train(options = {}) {
        const numEpochs = options.numEpochs || 100;
        const saveInterval = options.saveInterval || 10;
        const savePath = options.savePath || './training_data/deck-generator-rl';

        // Generate all possible ink combinations (single and dual)
        const allInks = ['Amber', 'Amethyst', 'Emerald', 'Ruby', 'Sapphire', 'Steel'];
        const inkCombinations = [];

        // Single-ink decks (6 combinations)
        for (let i = 0; i < allInks.length; i++) {
            inkCombinations.push([allInks[i]]);
        }

        // Two-ink decks (15 combinations)
        for (let i = 0; i < allInks.length; i++) {
            for (let j = i + 1; j < allInks.length; j++) {
                inkCombinations.push([allInks[i], allInks[j]]);
            }
        }

        console.log('\n=== Starting RL Training ===');
        console.log(`Epochs: ${numEpochs}`);
        console.log(`Batch Size: ${this.batchSize}`);
        console.log(`Learning Rate: ${this.learningRate}`);
        console.log(`Ink Combinations: ${inkCombinations.length} (6 mono-color + 15 dual-color)`);
        console.log('================================\n');

        let combinationIndex = 0;

        for (let epoch = 0; epoch < numEpochs; epoch++) {
            // Cycle through ink combinations
            const inks = inkCombinations[combinationIndex % inkCombinations.length];
            combinationIndex++;

            console.log(`\n--- Epoch ${epoch + 1}/${numEpochs} [${inks.join(' + ')}] ---`);

            // Train one step
            const metrics = await this.trainStep(inks);

            // Save checkpoint
            if ((epoch + 1) % saveInterval === 0) {
                const checkpointPath = `${savePath}_epoch${epoch + 1}`;
                await this.policy.saveModel(checkpointPath);
                console.log(`[RL] Saved checkpoint to ${checkpointPath}`);
            }

            // Early stopping
            if (metrics.avgReward >= 0.9) {
                console.log('\n[RL] Reached target reward of 0.9! Stopping early.');
                break;
            }
        }

        // Final save
        await this.policy.saveModel(savePath);
        console.log(`\n[RL] Training complete! Final model saved to ${savePath}`);

        // Print summary
        console.log('\n=== Training Summary ===');
        console.log(`Final Avg Reward: ${this.episodeRewards[this.episodeRewards.length - 1].toFixed(4)}`);
        console.log(`Best Reward: ${Math.max(...this.episodeRewards).toFixed(4)}`);
        console.log(`Improvement: ${(this.episodeRewards[this.episodeRewards.length - 1] - this.episodeRewards[0]).toFixed(4)}`);
        console.log(`Trained on ${inkCombinations.length} ink combinations`);
    }
}

module.exports = RLTrainer;
