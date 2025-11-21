/**
 * Quick test to verify low-diversity decks are caught
 */

const TrainingManager = require('./src/TrainingManager');

async function testLowDiversity() {
    console.log('Testing low-diversity deck detection...\n');

    const manager = new TrainingManager();
    await manager.fetchCards();
    await manager.precomputeEmbeddings();

    // Create a "60 Dalmatian Puppies" style deck
    const cardPool = Array.from(manager.cardMap.values());
    const randomCard = cardPool[Math.floor(Math.random() * cardPool.length)];
    const lowDiversityDeck = Array(60).fill(randomCard);

    const features = manager.extractDeckFeatures(lowDiversityDeck);

    console.log('Low diversity deck features:');
    console.log(`  Unique card diversity: ${features[0]} (normalized by 20)`);
    console.log(`  Estimated unique cards: ${Math.round(features[0] * 20)}`);
    console.log(`  Singleton ratio: ${features[1]}`);
    console.log(`  Four-of ratio: ${features[4]}`);
    console.log('\nThis should score LOW (<50%) after retraining!');
}

testLowDiversity().catch(console.error);
