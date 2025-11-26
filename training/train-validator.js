const TrainingManager = require('./src/TrainingManager');
const ValidationModel = require('./src/ValidationModel');

const epochs = parseInt(process.argv[2]) || 50;  // Increased from 20

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
    console.log('\n📊 Preparing validation dataset...');
    const { features, labels } = manager.prepareValidationDataset();
    console.log(`Dataset prepared: ${features.length} decks\n`);

    // 5. VALIDATION: Check dataset quality
    console.log('🔍 Validating dataset quality...');

    // Check labels
    const labelStats = {
        min: Math.min(...labels),
        max: Math.max(...labels),
        mean: labels.reduce((a, b) => a + b, 0) / labels.length,
        zeros: labels.filter(l => l === 0).length,
        ones: labels.filter(l => l === 1).length,
        between: labels.filter(l => l > 0 && l < 1).length,
        nan: labels.filter(l => isNaN(l)).length,
        infinite: labels.filter(l => !isFinite(l)).length
    };

    console.log(`Label Statistics:`);
    console.log(`  Range: [${labelStats.min}, ${labelStats.max}]`);
    console.log(`  Mean: ${labelStats.mean.toFixed(4)}`);
    console.log(`  Distribution:`);
    console.log(`    - Fake decks (0): ${labelStats.zeros} (${(labelStats.zeros / labels.length * 100).toFixed(1)}%)`);
    console.log(`    - Real decks (0.6-1.0): ${labelStats.between + labelStats.ones} (${((labelStats.between + labelStats.ones) / labels.length * 100).toFixed(1)}%)`);
    console.log(`    - Perfect decks (1.0): ${labelStats.ones} (${(labelStats.ones / labels.length * 100).toFixed(1)}%)`);

    if (labelStats.nan > 0 || labelStats.infinite > 0) {
        console.error(`\n❌ ERROR: Found ${labelStats.nan} NaN and ${labelStats.infinite} Infinity labels!`);
        process.exit(1);
    }

    // Check features
    let featuresWithNaN = 0;
    let featuresWithInfinity = 0;
    for (const featureVec of features) {
        if (featureVec.some(v => isNaN(v))) featuresWithNaN++;
        if (featureVec.some(v => !isFinite(v))) featuresWithInfinity++;
    }

    console.log(`\nFeature Statistics:`);
    console.log(`  Dimension: ${features[0].length}`);
    console.log(`  Features with NaN: ${featuresWithNaN}`);
    console.log(`  Features with Infinity: ${featuresWithInfinity}`);

    if (featuresWithNaN > 0 || featuresWithInfinity > 0) {
        console.error(`\n❌ ERROR: Found ${featuresWithNaN} features with NaN and ${featuresWithInfinity} with Infinity!`);
        process.exit(1);
    }

    console.log(`\n✅ Data validation passed!\n`);

    // Print sample data
    console.log('Sample predictions (before training):');
    const realIdx = labels.findIndex(l => l > 0.6);
    const fakeIdx = labels.findIndex(l => l === 0);
    console.log(`  Real deck example (label=${labels[realIdx].toFixed(2)}): features[0:5] = [${features[realIdx].slice(0, 5).map(v => v.toFixed(3)).join(', ')}...]`);
    console.log(`  Fake deck example (label=${labels[fakeIdx].toFixed(2)}): features[0:5] = [${features[fakeIdx].slice(0, 5).map(v => v.toFixed(3)).join(', ')}...]`);
    console.log();

    // 6. Initialize model
    const numericFeatureDim = 38; // From extractDeckFeatures
    await model.initialize(
        manager.textEmbedder.vocabularySize,
        numericFeatureDim
    );

    // 7. Train
    console.log('==================================================');
    console.log('🚀 Starting Training');
    console.log('==================================================');
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
