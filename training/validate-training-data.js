const TrainingManager = require('./src/TrainingManager');

console.log('==================================================');
console.log('Training Data Validation & Diagnostics');
console.log('==================================================\n');

async function validateTrainingData() {
    const manager = new TrainingManager();

    // 1. Fetch cards via CardApi
    console.log('📋 Step 1: Loading cards...');
    manager.cards = await manager.cardApi.getCards();
    console.log(`   ✓ Fetched ${manager.cards.length} cards.\n`);

    // Build card maps
    manager.cards.forEach((card) => {
        const key = manager.getCardKey(card.name, card.version);
        if (!manager.cardMap.has(key)) {
            const id = manager.cardMap.size;
            manager.cardMap.set(key, id);
            manager.indexMap.set(id, card);
        }
    });
    console.log(`   ✓ Indexed ${manager.cardMap.size} unique cards\n`);

    // 2. Build text vocabulary using TextEmbedder
    console.log('📚 Step 2: Building vocabulary...');
    manager.textEmbedder.buildVocabulary(manager.cards);
    console.log(`   ✓ Vocabulary size: ${manager.textEmbedder.vocabularySize}\n`);

    // 3. Compute TF-IDF embeddings for all cards
    console.log('🔢 Step 3: Computing TF-IDF embeddings...');
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
    console.log('   ✓ TF-IDF embeddings computed\n');

    // Validate embeddings
    console.log('🔍 Step 4: Validating embeddings...');
    let zeroEmbeddings = 0;
    let nanEmbeddings = 0;
    const embeddingStats = { min: Infinity, max: -Infinity, sum: 0, count: 0 };

    for (const [idx, card] of manager.indexMap.entries()) {
        if (!card.embedding || card.embedding.length === 0) {
            console.log(`   ⚠️  Card ${idx} (${card.name}) has no embedding!`);
            continue;
        }

        const isAllZero = card.embedding.every(v => v === 0);
        if (isAllZero) zeroEmbeddings++;

        const hasNaN = card.embedding.some(v => isNaN(v) || !isFinite(v));
        if (hasNaN) nanEmbeddings++;

        for (const val of card.embedding) {
            if (!isNaN(val) && isFinite(val)) {
                embeddingStats.min = Math.min(embeddingStats.min, val);
                embeddingStats.max = Math.max(embeddingStats.max, val);
                embeddingStats.sum += val;
                embeddingStats.count++;
            }
        }
    }

    console.log(`   Embeddings with all zeros: ${zeroEmbeddings}`);
    console.log(`   Embeddings with NaN/Infinity: ${nanEmbeddings}`);
    console.log(`   Embedding value range: [${embeddingStats.min.toFixed(4)}, ${embeddingStats.max.toFixed(4)}]`);
    console.log(`   Embedding mean: ${(embeddingStats.sum / embeddingStats.count).toFixed(4)}\n`);

    // Print sample embeddings
    console.log('   Sample embeddings (first 3 cards):');
    for (let i = 0; i < Math.min(3, manager.indexMap.size); i++) {
        const card = manager.indexMap.get(i);
        const embStr = card.embedding.slice(0, 5).map(v => v.toFixed(3)).join(', ');
        console.log(`   - Card ${i} (${card.name}): [${embStr}, ...]`);
    }
    console.log();

    // 4. Load training data
    console.log('📂 Step 5: Loading training data...');
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
    console.log(`   ✓ Loaded ${manager.trainingData.length} tournament files\n`);

    // 5. Prepare dataset
    console.log('🎯 Step 6: Preparing validation dataset...');
    const { features, labels } = manager.prepareValidationDataset();
    console.log(`   ✓ Dataset prepared: ${features.length} decks\n`);

    // 6. Validate labels
    console.log('🏷️  Step 7: Validating labels...');
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

    console.log(`   Label range: [${labelStats.min}, ${labelStats.max}]`);
    console.log(`   Label mean: ${labelStats.mean.toFixed(4)}`);
    console.log(`   Label distribution:`);
    console.log(`     - Exactly 0 (fake): ${labelStats.zeros} (${(labelStats.zeros / labels.length * 100).toFixed(1)}%)`);
    console.log(`     - Exactly 1 (perfect): ${labelStats.ones} (${(labelStats.ones / labels.length * 100).toFixed(1)}%)`);
    console.log(`     - Between 0-1: ${labelStats.between} (${(labelStats.between / labels.length * 100).toFixed(1)}%)`);
    console.log(`     - NaN values: ${labelStats.nan}`);
    console.log(`     - Infinite values: ${labelStats.infinite}\n`);

    if (labelStats.nan > 0 || labelStats.infinite > 0) {
        console.log('   ❌ ERROR: Found invalid labels (NaN or Infinity)!\n');
    }

    // 7. Validate features
    console.log('📊 Step 8: Validating features...');
    const featureDim = features[0].length;
    console.log(`   Feature dimension: ${featureDim}`);
    console.log(`   Expected: 38 (numeric) + 32 (mean emb) + 32 (max emb) + 32 (var emb) = 134\n`);

    // Check for NaN/Infinity in features
    let featuresWithNaN = 0;
    let featuresWithInfinity = 0;
    const featureStats = Array(featureDim).fill(null).map(() => ({
        min: Infinity,
        max: -Infinity,
        sum: 0,
        count: 0
    }));

    for (const featureVec of features) {
        if (featureVec.length !== featureDim) {
            console.log(`   ⚠️  Feature dimension mismatch: expected ${featureDim}, got ${featureVec.length}`);
            continue;
        }

        const hasNaN = featureVec.some(v => isNaN(v));
        const hasInf = featureVec.some(v => !isFinite(v));
        if (hasNaN) featuresWithNaN++;
        if (hasInf) featuresWithInfinity++;

        for (let i = 0; i < featureDim; i++) {
            const val = featureVec[i];
            if (!isNaN(val) && isFinite(val)) {
                featureStats[i].min = Math.min(featureStats[i].min, val);
                featureStats[i].max = Math.max(featureStats[i].max, val);
                featureStats[i].sum += val;
                featureStats[i].count++;
            }
        }
    }

    console.log(`   Features with NaN: ${featuresWithNaN}`);
    console.log(`   Features with Infinity: ${featuresWithInfinity}\n`);

    if (featuresWithNaN > 0 || featuresWithInfinity > 0) {
        console.log('   ❌ ERROR: Found invalid features (NaN or Infinity)!\n');
    }

    // Print statistics for first 10 features
    console.log('   Feature statistics (first 10 dimensions):');
    for (let i = 0; i < Math.min(10, featureDim); i++) {
        const stats = featureStats[i];
        const mean = stats.sum / stats.count;
        console.log(`     Feature ${i}: min=${stats.min.toFixed(4)}, max=${stats.max.toFixed(4)}, mean=${mean.toFixed(4)}`);
    }
    console.log();

    // 8. Print sample data
    console.log('🔬 Step 9: Sample data inspection...');
    console.log('\n   First 5 samples:');
    for (let i = 0; i < Math.min(5, features.length); i++) {
        const label = labels[i];
        const featureVec = features[i];
        const deckType = label === 0 ? 'FAKE' : (label === 1 ? 'PERFECT' : `SCORE=${label.toFixed(2)}`);
        const firstFeatures = featureVec.slice(0, 5).map(v => v.toFixed(3)).join(', ');
        console.log(`   [${i}] Label: ${label.toFixed(2)} (${deckType})`);
        console.log(`       Features: [${firstFeatures}, ...] (${featureVec.length} dims)`);
    }
    console.log();

    console.log('   Random fake deck sample:');
    const fakeIdx = labels.findIndex(l => l === 0);
    if (fakeIdx >= 0) {
        const featureVec = features[fakeIdx];
        const firstFeatures = featureVec.slice(0, 10).map(v => v.toFixed(3)).join(', ');
        console.log(`   [${fakeIdx}] Label: ${labels[fakeIdx].toFixed(2)} (FAKE)`);
        console.log(`       Features: [${firstFeatures}, ...]`);
    }
    console.log();

    console.log('   Random real deck sample:');
    const realIdx = labels.findIndex(l => l > 0.6);
    if (realIdx >= 0) {
        const featureVec = features[realIdx];
        const firstFeatures = featureVec.slice(0, 10).map(v => v.toFixed(3)).join(', ');
        console.log(`   [${realIdx}] Label: ${labels[realIdx].toFixed(2)} (REAL)`);
        console.log(`       Features: [${firstFeatures}, ...]`);
    }
    console.log();

    // 9. Summary
    console.log('==================================================');
    console.log('✅ Validation Summary');
    console.log('==================================================');
    console.log(`Total decks: ${features.length}`);
    console.log(`Feature dimension: ${featureDim}`);
    console.log(`Label range: [${labelStats.min}, ${labelStats.max}]`);
    console.log(`Dataset balance: ${labelStats.zeros} fake, ${labelStats.between + labelStats.ones} real/partial`);

    if (labelStats.nan > 0 || labelStats.infinite > 0 || featuresWithNaN > 0 || featuresWithInfinity > 0) {
        console.log('\n❌ DATA QUALITY ISSUES DETECTED!');
        console.log('   Please fix these issues before training.');
    } else {
        console.log('\n✅ Data quality looks good!');
        console.log('   Ready for training.');
    }
    console.log('==================================================\n');
}

validateTrainingData().catch(error => {
    console.error('❌ Validation failed:', error);
    console.error(error.stack);
    process.exit(1);
});
