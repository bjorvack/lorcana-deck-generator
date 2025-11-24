const RLTrainer = require('./src/RLTrainer');
const TrainingManager = require('./src/TrainingManager');
const ValidationModel = require('./src/ValidationModel');

/**
 * Test RL Components
 * Verify basic functionality before full training
 */
async function testRLComponents() {
    console.log('=== Testing RL Components ===\n');

    // Initialize Training Manager
    console.log('Test 1: Loading cards and building indices...');
    const trainingManager = new TrainingManager();
    trainingManager.cards = await trainingManager.cardApi.getCards();

    trainingManager.cards.forEach((card) => {
        const key = trainingManager.getCardKey(card.name, card.version);
        if (!trainingManager.cardMap.has(key)) {
            const id = trainingManager.cardMap.size;
            trainingManager.cardMap.set(key, id);
            trainingManager.indexMap.set(id, card);
        }
    });

    console.log(`✓ Loaded ${trainingManager.cards.length} cards`);
    console.log(`✓ Indexed ${trainingManager.cardMap.size} unique cards\n`);

    // Test 2: DeckModel RL methods
    console.log('Test 2: Testing DeckModel RL methods...');
    const testProbs = Array(10).fill(0).map((_, i) => i === 5 ? 0.5 : 0.05);

    // Test sampleAction
    const samples = [];
    for (let i = 0; i < 100; i++) {
        const action = trainingManager.model.sampleAction(testProbs);
        samples.push(action);
    }
    const mode = samples.reduce((acc, val) => {
        acc[val] = (acc[val] || 0) + 1;
        return acc;
    }, {});
    console.log(`  Sampled actions distribution (most frequent should be 5):`, mode);

    // Test getLogProb
    const logProb = trainingManager.model.getLogProb(testProbs, 5);
    console.log(`  Log prob of action 5: ${logProb.toFixed(4)} (expected: ${Math.log(0.5).toFixed(4)})`);

    if (Math.abs(logProb - Math.log(0.5)) < 0.01) {
        console.log('✓ DeckModel RL methods working correctly\n');
    } else {
        console.error('✗ Log probability mismatch!\n');
        process.exit(1);
    }

    // Test 3: ValidationModel
    console.log('Test 3: Testing ValidationModel...');
    const validator = new ValidationModel();
    // Create dummy features (134 dimensions: 38 numeric + 96 embedding)
    const dummyFeatures = Array(134).fill(0);
    dummyFeatures[0] = 0.75; // unique card diversity
    dummyFeatures[26] = 0.6; // inkable ratio

    validator.textVocabSize = 100;
    validator.numericFeatureDim = 38;
    await validator.initialize(validator.textVocabSize, validator.numericFeatureDim);

    const score = await validator.evaluate(dummyFeatures);
    console.log(`  Validator score for dummy deck: ${score.toFixed(4)}`);
    console.log('✓ ValidationModel working\n');

    // Test 4: Episode Collection (simplified)
    console.log('Test 4: Testing episode collection logic...');
    const rlTrainer = new RLTrainer(
        trainingManager.model,
        validator,
        trainingManager,
        { batchSize: 1 }
    );

    console.log('  Simulating card sampling with masking...');
    const mockDeck = [];
    const mockCounts = new Map();

    // Simulate adding 5 cards
    for (let i = 0; i < 5; i++) {
        const mockProbs = new Float32Array(trainingManager.cardMap.size).fill(1.0 / trainingManager.cardMap.size);
        const { action } = rlTrainer.sampleActionFromPolicy(mockProbs, mockDeck, mockCounts);
        mockDeck.push(action);
        mockCounts.set(action, (mockCounts.get(action) || 0) + 1);
        console.log(`    Step ${i + 1}: Added card ${action}, deck size: ${mockDeck.length}`);
    }

    console.log('✓ Episode collection logic working\n');

    console.log('=== All Tests Passed! ===');
    console.log('\nRL components are ready for training.');
    console.log('Run `npm run train-rl` to start RL training.');
}

testRLComponents().catch(error => {
    console.error('\n✗ Test failed:');
    console.error(error);
    process.exit(1);
});
