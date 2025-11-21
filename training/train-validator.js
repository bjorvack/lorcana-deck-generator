const TrainingManager = require('./src/TrainingManager');
const ValidationModel = require('./src/ValidationModel');

const epochs = parseInt(process.argv[2]) || 20;

console.log('==================================================');
console.log('Lorcana Deck Validator - Set-Based Training');
console.log('==================================================');
console.log(`Epochs: ${epochs}`);
console.log('==================================================\n');

async function trainValidator() {
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
    console.log(`Unique cards indexed: ${manager.cardMap.size}`);

    // 2. Build text vocabulary using TextEmbedder
    console.log('Building text vocabulary...');
    manager.textEmbedder.buildVocabulary(manager.cards);
    console.log(`Vocabulary size: ${manager.textEmbedder.vocabularySize}`);

    // 3. Compute TF-IDF embeddings for all cards
    console.log('Computing TF-IDF embeddings for cards...');
    const embeddingDim = 32;

    // Build IDF scores for vocabulary
    const documentFrequency = new Array(manager.textEmbedder.vocabularySize).fill(0);
    const totalDocs = manager.indexMap.size;

    // Count document frequency for each token
    for (const [idx, card] of manager.indexMap.entries()) {
        const textIndices = manager.textEmbedder.cardToTextIndices(card);
        const uniqueTokens = new Set([
            ...textIndices.name,
            ...textIndices.keywords,
            ...textIndices.ink,
            ...textIndices.classifications,
            ...textIndices.types,
            ...textIndices.text
        ]);

        for (const tokenIdx of uniqueTokens) {
            if (tokenIdx > 0) { // Skip PAD token
                documentFrequency[tokenIdx]++;
            }
        }
    }

    // Calculate IDF scores
    const idf = documentFrequency.map((df, idx) => {
        if (idx === 0 || df === 0) return 0; // PAD token or never seen
        return Math.log(totalDocs / df);
    });

    // Create TF-IDF embeddings for each card
    for (const [idx, card] of manager.indexMap.entries()) {
        const textIndices = manager.textEmbedder.cardToTextIndices(card);
        const allTokens = [
            ...textIndices.name,
            ...textIndices.keywords,
            ...textIndices.ink,
            ...textIndices.classifications,
            ...textIndices.types,
            ...textIndices.text
        ];

        // Count term frequency
        const termFrequency = new Array(manager.textEmbedder.vocabularySize).fill(0);
        for (const tokenIdx of allTokens) {
            if (tokenIdx > 0) {
                termFrequency[tokenIdx]++;
            }
        }

        // Calculate TF-IDF vector (full vocab size)
        const tfidfVector = termFrequency.map((tf, i) => tf * idf[i]);

        // Reduce to fixed embedding dimension using bucketing/hashing
        const embedding = new Array(embeddingDim).fill(0);
        for (let i = 0; i < tfidfVector.length; i++) {
            const bucket = i % embeddingDim;
            embedding[bucket] += tfidfVector[i];
        }

        // Normalize
        const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
        if (norm > 0) {
            for (let i = 0; i < embeddingDim; i++) {
                embedding[i] /= norm;
            }
        }

        card.embedding = embedding;
    }
    console.log('TF-IDF embeddings computed');

    // 3. Load training data manually
    console.log('Loading tournament data...');
    const fs = require('fs');
    const path = require('path');
    const manifestPath = path.join(manager.trainingDataPath, 'manifest.json');
    const allFiles = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    for (const file of allFiles) {
        const filePath = path.join(manager.trainingDataPath, file);
        if (fs.existsSync(filePath)) {
            const rawData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            manager.trainingData.push(rawData);
        }
    }
    console.log(`Loaded ${manager.trainingData.length} tournament files`);

    // 4. Prepare dataset with aggregated features
    const { features, labels } = manager.prepareValidationDataset();

    // 5. Initialize model
    const numericFeatureDim = 38; // From extractDeckFeatures
    await model.initialize(
        manager.textEmbedder.vocabularySize,
        numericFeatureDim
    );

    // 6. Train
    await model.train(features, labels, epochs);

    // 7. Save
    const savePath = path.join(__dirname, '..', 'training_data', 'deck-validator-model');
    await model.saveModel(savePath);

    //8. Test on sample decks
    console.log('\n==================================================');
    console.log('Testing model on sample decks...');
    console.log('==================================================');

    // Test real deck
    const realDeck = manager.trainingData[0].decks[0];
    const realDeckIndices = [];
    for (const cardEntry of realDeck.cards) {
        const key = manager.getCardKey(cardEntry.name, cardEntry.version);
        if (manager.cardMap.has(key)) {
            const index = manager.cardMap.get(key);
            for (let i = 0; i < cardEntry.amount; i++) {
                realDeckIndices.push(index);
            }
        }
    }
    const realFeatures = manager.extractDeckFeaturesWithEmbeddings(realDeckIndices.slice(0, 60));
    const realResult = await model.evaluateWithBreakdown(realFeatures);
    console.log(`Real tournament deck score: ${(realResult.score * 100).toFixed(1)}% (${realResult.grade})`);
    console.log(`Message: ${realResult.message}`);
    if (realResult.breakdown.length > 0) {
        console.log('Issues:', realResult.breakdown.map(b => b.message).join(', '));
    }

    // Test fake decks
    for (const strategy of ['pure_random', 'ink_constrained', 'rule_broken', 'low_diversity']) {
        const fakeDeck = manager.generateFakeDeck(strategy);
        const fakeFeatures = manager.extractDeckFeaturesWithEmbeddings(fakeDeck.slice(0, 60));
        const fakeResult = await model.evaluateWithBreakdown(fakeFeatures);
        console.log(`Fake deck (${strategy}) score: ${(fakeResult.score * 100).toFixed(1)}% (${fakeResult.grade})`);
    }

    console.log('\n==================================================');
    console.log('Validation model training complete!');
    console.log('==================================================');
}

trainValidator().catch(error => {
    console.error('Training failed:', error);
    console.error(error.stack);
    process.exit(1);
});
