const RLTrainer = require('./src/RLTrainer');
const TrainingManager = require('./src/TrainingManager');
const ValidationModel = require('./src/ValidationModel');
const fs = require('fs');
const path = require('path');

/**
 * RL Training Script
 * Fine-tunes the deck generator using validator scores as reward
 */
async function main() {
    console.log('\n╔══════════════════════════════════════╗');
    console.log('║  RL Training for Deck Generator      ║');
    console.log('╚══════════════════════════════════════╝\n');

    // Initialize Training Manager
    console.log('[1/5] Initialize Training Manager...');
    const trainingManager = new TrainingManager();

    // Load cards
    console.log('[2/5] Loading cards...');
    trainingManager.cards = await trainingManager.cardApi.getCards();
    console.log(`  ✓ Loaded ${trainingManager.cards.length} cards`);

    // Build card maps
    console.log('[3/5] Building card indices...');
    trainingManager.cards.forEach((card) => {
        const key = trainingManager.getCardKey(card.name, card.version);
        if (!trainingManager.cardMap.has(key)) {
            const id = trainingManager.cardMap.size;
            trainingManager.cardMap.set(key, id);
            trainingManager.indexMap.set(id, card);
        }
    });
    console.log(`  ✓ Indexed ${trainingManager.cardMap.size} unique cards`);

    // Load pre-trained DeckModel
    console.log('[4/5] Loading pre-trained deck model...');
    const deckModelPath = path.join(__dirname, '..', 'training_data', 'deck-generator-model', 'model.json');
    if (!fs.existsSync(deckModelPath)) {
        console.error('  ✗ Error: Pre-trained deck model not found!');
        console.error(`  Expected at: ${deckModelPath}`);
        console.error('  Please train the base model first using: npm run train');
        process.exit(1);
    }
    await trainingManager.model.loadModel(deckModelPath);
    console.log('  ✓ Deck model loaded');

    // Load ValidationModel
    console.log('[5/5] Loading validation model...');
    const validator = new ValidationModel();
    const validatorPath = path.join(__dirname, '..', 'training_data', 'deck-validator-model', 'model.json');
    if (!fs.existsSync(validatorPath)) {
        console.error('  ✗ Error: Validation model not found!');
        console.error(`  Expected at: ${validatorPath}`);
        console.error('  Please train the validator first using: npm run train-validator');
        process.exit(1);
    }
    const validatorDir = path.join(__dirname, '..', 'training_data', 'deck-validator-model');
    await validator.loadModel(validatorDir);
    console.log('  ✓ Validator model loaded');

    console.log('\n✓ All models loaded successfully!\n');

    // Create RL Trainer
    console.log('Creating RL Trainer...');
    const rlTrainer = new RLTrainer(
        trainingManager.model,
        validator,
        trainingManager,
        {
            learningRate: 0.0001,  // Low LR for fine-tuning
            batchSize: 5,          // Small batch for faster iteration
            gamma: 0.99,
            useBaseline: true,
            entropyCoef: 0.01
        }
    );
    console.log('✓ RL Trainer ready\n');

    // Start RL Training
    await rlTrainer.train({
        numEpochs: 50,              // Start with fewer epochs
        saveInterval: 10,
        savePath: path.join(__dirname, '..', 'training_data', 'deck-generator-rl')
    });

    console.log('\n✓ RL Training Complete!');

    // Cleanup intermediate checkpoints
    console.log('Cleaning up intermediate checkpoints...');
    const trainingDataDir = path.join(__dirname, '..', 'training_data');
    const files = fs.readdirSync(trainingDataDir);

    let cleanedCount = 0;
    files.forEach(file => {
        if (file.startsWith('deck-generator-rl_epoch')) {
            const checkpointPath = path.join(trainingDataDir, file);
            try {
                fs.rmSync(checkpointPath, { recursive: true, force: true });
                cleanedCount++;
            } catch (e) {
                console.warn(`Failed to remove checkpoint ${file}: ${e.message}`);
            }
        }
    });

    if (cleanedCount > 0) {
        console.log(`✓ Removed ${cleanedCount} intermediate checkpoint folders`);
    } else {
        console.log('No intermediate checkpoints found to clean');
    }

    console.log('\n');
}

// Run training
main().catch(error => {
    console.error('\n✗ RL Training failed:');
    console.error(error);
    process.exit(1);
});
