const tf = require('@tensorflow/tfjs-node')

/**
 * RLTrainer - REINFORCE algorithm for training deck generator
 * Uses validator scores as reward signal to fine-tune policy network
 */
class RLTrainer {
  constructor (policyModel, validatorModel, trainingManager, options = {}) {
    this.policy = policyModel
    this.validator = validatorModel
    this.trainingManager = trainingManager

    // Hyperparameters
    this.learningRate = options.learningRate || 0.0001
    this.batchSize = options.batchSize || 10
    this.gamma = options.gamma || 0.99 // Discount factor
    this.useBaseline = options.useBaseline !== false // Default true
    this.entropyCoef = options.entropyCoef || 0.01 // Exploration bonus
    this.maxGradNorm = options.maxGradNorm || 1.0 // Gradient clipping

    // Optimizer
    this.optimizer = tf.train.adam(this.learningRate)

    // Metrics
    this.episodeRewards = []
    this.baseline = 0.5 // Running average of rewards

    // Experience Replay Buffer
    this.replayBufferSize = options.replayBufferSize || 1000
    this.replayBuffer = []
    this.replayRatio = options.replayRatio || 0.3 // 30% of batch from replay
    this.minRewardForReplay = 0.6 // Only store episodes with reward >= this
  }

  /**
   * Add episode to replay buffer
   * Only stores high-quality episodes for replay
   */
  addToReplayBuffer (episode) {
    // Only store good episodes to improve sample efficiency
    if (episode.reward >= this.minRewardForReplay) {
      // Store a copy (not reference) to avoid mutation
      this.replayBuffer.push({
        states: episode.states.map(s => [...s]),
        actions: [...episode.actions],
        logProbs: [...episode.logProbs],
        reward: episode.reward
      })

      // Remove oldest if buffer full
      if (this.replayBuffer.length > this.replayBufferSize) {
        this.replayBuffer.shift()
      }
    }
  }

  /**
   * Sample from replay buffer for training
   * @param {Number} batchSize - Number of samples to return
   * @returns {Array} Sample episodes from buffer
   */
  sampleFromReplayBuffer (batchSize) {
    if (this.replayBuffer.length === 0) return []

    const samples = []
    const numSamples = Math.min(batchSize, this.replayBuffer.length)

    // Random sampling from buffer
    for (let i = 0; i < numSamples; i++) {
      const idx = Math.floor(Math.random() * this.replayBuffer.length)
      samples.push(this.replayBuffer[idx])
    }

    return samples
  }

  /**
   * Get replay buffer statistics
   */
  getReplayStats () {
    if (this.replayBuffer.length === 0) {
      return { size: 0, avgReward: 0, maxReward: 0 }
    }

    const rewards = this.replayBuffer.map(e => e.reward)
    return {
      size: this.replayBuffer.length,
      avgReward: rewards.reduce((a, b) => a + b, 0) / rewards.length,
      maxReward: Math.max(...rewards)
    }
  }

  /**
     * Collect one episode (generate one full deck)
     * Returns: { states, actions, logProbs, reward }
     */
  async collectEpisode (inks) {
    const episode = {
      states: [], // Deck states at each step
      actions: [], // Card indices chosen
      logProbs: [], // Log probabilities of actions
      reward: 0 // Terminal reward from validator
    }

    const deck = []
    const cardCounts = new Map()
    const deckKeywords = new Set() // Track keywords for synergy

    // Generate deck card by card
    while (deck.length < 60) {
      // Current state
      episode.states.push([...deck])

      // Build context for synergy-aware prediction
      const context = {
        synergyMatrix: this.trainingManager.cooccurrenceMatrix,
        keywords: deckKeywords
      }

      // Get action probabilities from policy with context for synergy
      const probs = await this.policy.predictWithContext
        ? await this.policy.predictWithContext(deck, context)
        : await this.policy.predict(deck)

      // Sample action using policy
      const { action, logProb } = this.sampleActionFromPolicy(probs, deck, cardCounts, inks)

      episode.actions.push(action)
      episode.logProbs.push(logProb)

      // Execute action
      deck.push(action)
      cardCounts.set(action, (cardCounts.get(action) || 0) + 1)

      // Update keyword tracking
      const cardKeywords = this.trainingManager.cardKeywordsMap.get(action)
      if (cardKeywords) {
        for (const kw of cardKeywords) {
          deckKeywords.add(kw)
        }
      }
    }

    // Get terminal reward from validator
    const deckFeatures = this.trainingManager.extractDeckFeaturesWithEmbeddings(deck)
    
    // Pass 'inks' context to validator.
    // The validator will penalize decks that don't match the learned ink profile patterns.
    const validatorReward = await this.validator.evaluate(deckFeatures, inks)

    // Calculate Consistency Reward (Bonus for multiple copies)
    const consistencyReward = this.calculateConsistencyReward(deck)

    // Calculate Synergy Rewards
    const synergyReward = this.calculateSynergyReward(deck)
    const keywordSynergyReward = this.calculateKeywordSynergyReward(deck)

    // Calculate Ability Combo Reward
    const abilityComboReward = this.calculateAbilityComboReward(deck)

    // Weighted sum:
    // Validator (Quality & Balance): 55% - Let the learned model decide what is "good"
    // Consistency (Structure): 10% - Reward playing multiple copies
    // Card Synergy: 15% - Reward cards that commonly appear together
    // Keyword Synergy: 10% - Reward complementary keywords
    // Ability Combo: 10% - Reward completing ability combos
    episode.reward = (validatorReward * 0.55) + (consistencyReward * 0.1) + (synergyReward * 0.15) + (keywordSynergyReward * 0.1) + (abilityComboReward * 0.1)

    return episode
  }

  /**
   * Calculate consistency score based on card repetition
   * Returns 0.0 (all singletons) to ~1.0 (highly consistent)
   */
  calculateConsistencyReward (deck) {
    if (deck.length === 0) return 0

    const cardCounts = new Map()
    for (const idx of deck) {
      cardCounts.set(idx, (cardCounts.get(idx) || 0) + 1)
    }

    const uniqueCards = cardCounts.size
    const totalCards = deck.length

    // Repetition Ratio: 1.0 - (unique / total)
    // Examples (60 cards):
    // - 60 unique (1x each): 1 - 1 = 0.0
    // - 30 unique (2x each): 1 - 0.5 = 0.5
    // - 15 unique (4x each): 1 - 0.25 = 0.75
    const repetitionRatio = 1.0 - (uniqueCards / totalCards)

    // Boost the signal slightly to make it comparable to validator score
    return Math.min(1.0, repetitionRatio * 1.3)
  }

  /**
   * Calculate synergy reward based on learned co-occurrence patterns
   * Uses the training manager's co-occurrence matrix to score card synergies
   * @param {Array} deck - Array of card indices
   * @returns {Number} Synergy score (0-1)
   */
  calculateSynergyReward (deck) {
    if (deck.length < 2) return 0

    // Use the training manager's synergy methods
    const synergyScore = this.trainingManager.calculateDeckSynergy(deck)
    return synergyScore
  }

  /**
   * Calculate keyword synergy reward
   * @param {Array} deck - Array of card indices
   * @returns {Number} Keyword synergy score (0-1)
   */
  calculateKeywordSynergyReward (deck) {
    if (deck.length < 2) return 0

    // Collect all keywords from deck
    const deckKeywords = new Set()
    for (const cardId of deck) {
      const cardKeywords = this.trainingManager.cardKeywordsMap.get(cardId)
      if (cardKeywords) {
        for (const kw of cardKeywords) {
          deckKeywords.add(kw)
        }
      }
    }

    if (deckKeywords.size < 2) return 0

    // Calculate pairwise keyword synergies
    let totalSynergy = 0
    let count = 0
    const kwArray = Array.from(deckKeywords)

    for (let i = 0; i < Math.min(kwArray.length, 10); i++) {
      for (let j = i + 1; j < Math.min(kwArray.length, 10); j++) {
        const synergies = this.trainingManager.keywordSynergyMatrix.get(kwArray[i])
        if (synergies) {
          const score = synergies.get(kwArray[j])
          if (score) {
            totalSynergy += score
            count++
          }
        }
      }
    }

    return count > 0 ? Math.min(1, totalSynergy / count * 5) : 0
  }

  /**
   * Calculate ability combo reward
   * Rewards having complete ability combos (e.g., multiple singers)
   * @param {Array} deck - Array of card indices
   * @returns {Number} Combo reward (0-1)
   */
  calculateAbilityComboReward (deck) {
    return this.trainingManager.calculateAbilityComboScore(deck)
  }

  /**
     * Sample action from policy with exploration
     * Filters invalid actions (exceeds max count)
     */
  sampleActionFromPolicy (probs, currentDeck, cardCounts, allowedInks) {
    // Create array from Float32Array
    const probsArray = Array.from(probs)

    // Mask invalid actions (cards at max count or wrong ink)
    const maskedProbs = probsArray.map((p, idx) => {
      const card = this.trainingManager.indexMap.get(idx)
      if (!card) return 0

      const count = cardCounts.get(idx) || 0
      const maxAmount = card.maxAmount || 4

      // Can't add more if at max
      if (count >= maxAmount) return 0

      // Check Ink Constraints
      if (allowedInks && allowedInks.length > 0) {
        const cardInks = card.inks || (card.ink ? [card.ink] : [])
        if (cardInks.length > 0) {
          const isAllowed = cardInks.every(ink => allowedInks.includes(ink))
          if (!isAllowed) return 0
        }
      }

      return p
    })

    // Renormalize
    const sum = maskedProbs.reduce((a, b) => a + b, 0)
    if (sum === 0) {
      // Fallback: uniform over valid actions
      const validActions = maskedProbs.map((p, i) => {
        // Re-check validity since p is 0
        const card = this.trainingManager.indexMap.get(i)
        if (!card) return -1
        const count = cardCounts.get(i) || 0
        const maxAmount = card.maxAmount || 4
        if (count >= maxAmount) return -1

        if (allowedInks && allowedInks.length > 0) {
          const cardInks = card.inks || (card.ink ? [card.ink] : [])
          if (cardInks.length > 0 && !cardInks.every(ink => allowedInks.includes(ink))) return -1
        }
        return i
      }).filter(i => i >= 0)

      if (validActions.length === 0) {
        console.warn('No valid actions available!')
        return { action: 0, logProb: 0 }
      }
      const action = validActions[Math.floor(Math.random() * validActions.length)]
      return { action, logProb: Math.log(1.0 / validActions.length) }
    }

    const normalized = maskedProbs.map(p => p / sum)

    // Sample from categorical distribution
    const rand = Math.random()
    let cumsum = 0
    for (let i = 0; i < normalized.length; i++) {
      cumsum += normalized[i]
      if (rand < cumsum) {
        const logProb = Math.log(Math.max(normalized[i], 1e-10))
        return { action: i, logProb }
      }
    }

    // Fallback (shouldn't reach here)
    const action = normalized.length - 1
    const logProb = Math.log(Math.max(normalized[action], 1e-10))
    return { action, logProb }
  }

  /**
     * Compute returns for an episode using reward-to-go
     * Each step receives the discounted sum of future rewards only
     */
  computeReturns (episode) {
    const returns = []
    let discountedReturn = 0

    // Use reward-to-go: each step gets the discounted sum of rewards from that point forward
    // This provides better credit assignment than giving all steps the same reward
    for (let t = episode.logProbs.length - 1; t >= 0; t--) {
      discountedReturn = episode.reward * Math.pow(this.gamma, episode.logProbs.length - 1 - t) + discountedReturn
      returns.unshift(discountedReturn)
    }

    return returns
  }

  /**
     * Train one step: collect episodes and update policy
     */
  async trainStep (inks) {
    console.log(`\n[RL] Collecting ${this.batchSize} episodes...`)
    const episodes = []

    // Collect batch of episodes
    for (let i = 0; i < this.batchSize; i++) {
      const episode = await this.collectEpisode(inks)
      episodes.push(episode)

      // Add to replay buffer
      this.addToReplayBuffer(episode)

      process.stdout.write(`\r  Episode ${i + 1}/${this.batchSize}: reward = ${episode.reward.toFixed(3)}`)
    }
    console.log('') // Newline

    // Mix in replay samples if available
    let allEpisodes = episodes
    if (this.replayBuffer.length > 0) {
      const replaySamples = this.sampleFromReplayBuffer(
        Math.floor(this.batchSize * this.replayRatio)
      )
      if (replaySamples.length > 0) {
        allEpisodes = [...episodes, ...replaySamples]
        console.log(`[RL] Replay buffer: ${this.replayBuffer.length} episodes (using ${replaySamples.length} in this batch)`)
      }
    }

    // Compute statistics
    const rewards = episodes.map(ep => ep.reward)
    const avgReward = rewards.reduce((a, b) => a + b, 0) / rewards.length
    const stdReward = Math.sqrt(
      rewards.reduce((sum, r) => sum + Math.pow(r - avgReward, 2), 0) / rewards.length
    )

    // Update baseline
    if (this.useBaseline) {
      this.baseline = this.baseline * 0.9 + avgReward * 0.1 // EMA
    }

    // Compute policy gradient and update (use all episodes for training)
    const lossValue = await this.updatePolicy(allEpisodes)

    // Track metrics
    this.episodeRewards.push(avgReward)

    // Print replay stats
    const replayStats = this.getReplayStats()
    console.log(`[RL] Replay: ${replayStats.size} episodes, avg reward: ${replayStats.avgReward.toFixed(3)}`)
    console.log(`[RL] Avg Reward: ${avgReward.toFixed(4)} ± ${stdReward.toFixed(4)}`)
    console.log(`[RL] Baseline: ${this.baseline.toFixed(4)}`)
    console.log(`[RL] Loss: ${lossValue.toFixed(4)}`)

    return {
      avgReward,
      stdReward,
      baseline: this.baseline,
      loss: lossValue,
      replayStats
    }
  }

  /**
     * Update policy using REINFORCE algorithm
     */
  async updatePolicy (episodes) {
    // 1. Prepare data
    const states = []
    const actions = []
    const advantages = []

    for (const episode of episodes) {
      const returns = this.computeReturns(episode)

      for (let t = 0; t < episode.states.length; t++) {
        // Pad state to maxLen
        const deck = episode.states[t]
        const paddedSeq = new Array(this.policy.maxLen).fill(0)
        const startIdx = Math.max(0, this.policy.maxLen - deck.length)
        for (let j = 0; j < Math.min(deck.length, this.policy.maxLen); j++) {
          paddedSeq[startIdx + j] = deck[j]
        }

        states.push(paddedSeq)
        actions.push(episode.actions[t])

        const advantage = this.useBaseline
          ? returns[t] - this.baseline
          : returns[t]
        advantages.push(advantage)
      }
    }

    // 2. Convert to Tensors
    const statesTensor = tf.tensor2d(states, [states.length, this.policy.maxLen], 'int32')
    const actionsTensor = tf.tensor1d(actions, 'int32')
    const advantagesTensor = tf.tensor1d(advantages, 'float32')

    // 3. Compute Gradients & Update
    const lossFunction = () => {
      // Forward pass
      const logits = this.policy.model.predict(statesTensor)

      // Calculate log probs
      // Add epsilon to avoid log(0)
      const logProbs = tf.log(tf.add(logits, 1e-10))

      // Select log prob of taken actions
      const actionMask = tf.oneHot(actionsTensor, this.policy.vocabSize)
      const selectedLogProbs = tf.sum(tf.mul(logProbs, actionMask), 1)

      // Loss = -mean(log_prob * advantage)
      // We want to maximize reward, so minimize negative reward
      const loss = tf.mean(tf.mul(tf.neg(selectedLogProbs), advantagesTensor))

      // Add entropy regularization
      if (this.entropyCoef > 0) {
        const entropy = tf.neg(tf.sum(tf.mul(logits, logProbs), 1))
        const meanEntropy = tf.mean(entropy)
        return tf.sub(loss, tf.mul(meanEntropy, this.entropyCoef))
      }

      return loss
    }

    // Apply gradients
    // minimize returns the value of the loss function
    const varList = this.policy.model.trainableWeights.map(w => w.val)
    const loss = this.optimizer.minimize(lossFunction, true, varList)

    const lossValue = loss.dataSync()[0]

    // Cleanup
    statesTensor.dispose()
    actionsTensor.dispose()
    advantagesTensor.dispose()
    loss.dispose()

    return lossValue
  }

  /**
     * Main training loop
     */
  async train (options = {}) {
    const numEpochs = options.numEpochs || 100
    const saveInterval = options.saveInterval || 10
    const savePath = options.savePath || './training_data/deck-generator-rl'

    // Generate all possible ink combinations (single and dual)
    const allInks = ['Amber', 'Amethyst', 'Emerald', 'Ruby', 'Sapphire', 'Steel']
    const inkCombinations = []

    // Single-ink decks (6 combinations)
    for (let i = 0; i < allInks.length; i++) {
      inkCombinations.push([allInks[i]])
    }

    // Two-ink decks (15 combinations)
    for (let i = 0; i < allInks.length; i++) {
      for (let j = i + 1; j < allInks.length; j++) {
        inkCombinations.push([allInks[i], allInks[j]])
      }
    }

    console.log('\n=== Starting RL Training ===')
    console.log(`Epochs: ${numEpochs}`)
    console.log(`Batch Size: ${this.batchSize}`)
    console.log(`Learning Rate: ${this.learningRate}`)
    console.log(`Ink Combinations: ${inkCombinations.length} (6 mono-color + 15 dual-color)`)
    console.log('================================\n')

    let combinationIndex = 0

    for (let epoch = 0; epoch < numEpochs; epoch++) {
      // Cycle through ink combinations
      const inks = inkCombinations[combinationIndex % inkCombinations.length]
      combinationIndex++

      console.log(`\n--- Epoch ${epoch + 1}/${numEpochs} [${inks.join(' + ')}] ---`)

      // Train one step
      const metrics = await this.trainStep(inks)

      // Save checkpoint
      if ((epoch + 1) % saveInterval === 0) {
        const checkpointPath = `${savePath}_epoch${epoch + 1}`
        await this.policy.saveModel(checkpointPath)
        console.log(`[RL] Saved checkpoint to ${checkpointPath}`)
      }

      // Early stopping
      if (metrics.avgReward >= 0.9) {
        console.log('\n[RL] Reached target reward of 0.9! Stopping early.')
        break
      }
    }

    // Final save
    await this.policy.saveModel(savePath)
    console.log(`\n[RL] Training complete! Final model saved to ${savePath}`)

    // Print summary
    console.log('\n=== Training Summary ===')
    console.log(`Final Avg Reward: ${this.episodeRewards[this.episodeRewards.length - 1].toFixed(4)}`)
    console.log(`Best Reward: ${Math.max(...this.episodeRewards).toFixed(4)}`)
    console.log(`Improvement: ${(this.episodeRewards[this.episodeRewards.length - 1] - this.episodeRewards[0]).toFixed(4)}`)
    console.log(`Trained on ${inkCombinations.length} ink combinations`)
  }
}

module.exports = RLTrainer
