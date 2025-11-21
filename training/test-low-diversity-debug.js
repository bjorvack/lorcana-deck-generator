const TrainingManager = require('./src/TrainingManager');
const ValidationModel = require('./src/ValidationModel');

async function testLowDiversity() {
    const manager = new TrainingManager();
    const model = new ValidationModel();

    // 1. Fetch cards via CardApi
    console.log('Fetching cards...');
    manager.cards = await manager.cardApi.getCards();
    console.log(`Fetched ${manager.cards.length} cards.`);

    // Build card maps
    manager.cards.forEach((card) => {
        const key = manager.getCardKey(card.name, card.version);
        if (!manager.cardMap.has(key)) {
            const id = manager.cardMap.size;
            manager.cardMap.set(key, id);
            manager.indexMap.set(id, card);
        }
    });

    // Build vocabulary
    manager.textEmbedder.buildVocabulary(manager.cards);

    // Compute embeddings (simplified from train-validator)
    const embeddingDim = 32;
    const documentFrequency = new Array(manager.textEmbedder.vocabularySize).fill(0);
    const totalDocs = manager.indexMap.size;

    for (const [idx, card] of manager.indexMap.entries()) {
        const textIndices = manager.textEmbedder.cardToTextIndices(card);
        const uniqueTokens = new Set([
            ...textIndices.name, ...textIndices.keywords, ...textIndices.ink,
            ...textIndices.classifications, ...textIndices.types, ...textIndices.text
        ]);
        for (const tokenIdx of uniqueTokens) {
            if (tokenIdx > 0) documentFrequency[tokenIdx]++;
        }
    }

    const idf = documentFrequency.map((df, idx) => {
        if (idx === 0 || df === 0) return 0;
        return Math.log(totalDocs / df);
    });

    for (const [idx, card] of manager.indexMap.entries()) {
        const textIndices = manager.textEmbedder.cardToTextIndices(card);
        const allTokens = [
            ...textIndices.name, ...textIndices.keywords, ...textIndices.ink,
            ...textIndices.classifications, ...textIndices.types, ...textIndices.text
        ];

        const termFrequency = new Array(manager.textEmbedder.vocabularySize).fill(0);
        for (const tokenIdx of allTokens) {
            if (tokenIdx > 0) termFrequency[tokenIdx]++;
        }

        const tfidfVector = termFrequency.map((tf, i) => tf * idf[i]);
        const embedding = new Array(embeddingDim).fill(0);
        for (let i = 0; i < tfidfVector.length; i++) {
            embedding[i % embeddingDim] += tfidfVector[i];
        }

        const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
        if (norm > 0) {
            for (let i = 0; i < embeddingDim; i++) {
                embedding[i] /= norm;
            }
        }

        card.embedding = embedding;
    }

    // Load model
    const path = require('path');
    const modelPath = path.join(__dirname, '..', 'training_data', 'deck-validator-model');
    await model.loadModel(modelPath);

    // Test low-diversity deck
    console.log('\n=== Testing Low-Diversity Deck ===');
    const fakeDeck = manager.generateFakeDeck('low_diversity');
    const fakeFeatures = manager.extractDeckFeaturesWithEmbeddings(fakeDeck.slice(0, 60));

    console.log('\nDeck composition:');
    const cardCounts = new Map();
    for (const idx of fakeDeck) {
        cardCounts.set(idx, (cardCounts.get(idx) || 0) + 1);
    }
    console.log(`Unique cards: ${cardCounts.size}`);
    for (const [idx, count] of cardCounts.entries()) {
        const card = manager.indexMap.get(idx);
        console.log(`  ${card.name}: ${count} copies`);
    }

    console.log('\nFeature analysis:');
    console.log(`Feature[0] (unique card diversity): ${fakeFeatures[0].toFixed(4)} (expected: ${(cardCounts.size / 20).toFixed(4)})`);
    console.log(`Feature dimension: ${fakeFeatures.length}`);
    console.log(`First 10 numeric features: ${fakeFeatures.slice(0, 10).map(f => f.toFixed(3)).join(', ')}`);

    // Check embedding variance (should be in features[38+32+32] to features[38+32+32+32])
    const varStart = 38 + 32 + 32;
    const varEnd = varStart + 32;
    const varFeatures = fakeFeatures.slice(varStart, varEnd);
    const avgVar = varFeatures.reduce((a, b) => a + b, 0) / varFeatures.length;
    console.log(`Embedding variance (avg): ${avgVar.toFixed(6)}`);

    const result = await model.evaluateWithBreakdown(fakeFeatures);
    console.log(`\nScore: ${(result.score * 100).toFixed(1)}% (${result.grade})`);
    console.log(`Message: ${result.message}`);
    if (result.breakdown.length > 0) {
        console.log('Issues detected:', result.breakdown.map(b => b.message).join(', '));
    }
}

testLowDiversity().catch(error => {
    console.error('Test failed:', error);
    console.error(error.stack);
    process.exit(1);
});
