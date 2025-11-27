const tf = require('@tensorflow/tfjs-node');
const CardApi = require('./src/CardApi');
const DeckModel = require('./src/DeckModel');
const ValidationModel = require('./src/ValidationModel');
const TextEmbedder = require('./src/TextEmbedder');
const path = require('path');
const fs = require('fs');

const numDecks = parseInt(process.argv[2]) || 10;

console.log('==================================================');
console.log('Deck Generator Evaluation');
console.log('==================================================');
console.log(`Number of decks to generate: ${numDecks}`);
console.log('==================================================\n');

async function evaluateGenerator() {
    const cardApi = new CardApi();
    const deckModel = new DeckModel();
    const validationModel = new ValidationModel();
    const textEmbedder = new TextEmbedder();

    // 1. Load cards
    console.log('📋 Loading cards...');
    const cards = await cardApi.getCards();
    console.log(`   ✓ Loaded ${cards.length} cards\n`);

    // Build card maps
    const cardMap = new Map();
    const indexMap = new Map();
    cards.forEach((card) => {
        const key = `${card.name}|${card.version || ''}`.toLowerCase();
        if (!cardMap.has(key)) {
            const id = cardMap.size;
            cardMap.set(key, id);
            indexMap.set(id, card);
        }
    });

    // 2. Load vocabulary
    console.log('📚 Loading text embedder...');
    const vocabPath = path.join(__dirname, '..', 'training_data', 'vocabulary.json');
    if (fs.existsSync(vocabPath)) {
        textEmbedder.load(vocabPath);
        console.log(`   ✓ Vocabulary loaded: ${textEmbedder.vocabularySize} tokens\n`);
    } else {
        console.log('   Building vocabulary from cards...');
        textEmbedder.buildVocabulary(cards);
        console.log(`   ✓ Vocabulary built: ${textEmbedder.vocabularySize} tokens\n`);
    }

    // 3. Load deck generator model
    console.log('🎲 Loading deck generator model...');
    const generatorModelPath = path.join(__dirname, '..', 'training_data', 'deck-generator-model', 'model.json');
    try {
        await deckModel.loadModel(generatorModelPath);
        console.log(`   ✓ Generator model loaded\n`);
    } catch (e) {
        console.error(`   ❌ Failed to load generator model: ${e.message}`);
        console.error('   Make sure you have trained the generator model first.');
        process.exit(1);
    }

    // 4. Compute TF-IDF embeddings for validation
    console.log('🔢 Computing TF-IDF embeddings...');
    const embeddingDim = 32;
    const documentFrequency = new Array(textEmbedder.vocabularySize).fill(0);
    const totalDocs = indexMap.size;

    for (const [idx, card] of indexMap.entries()) {
        const textIndices = textEmbedder.cardToTextIndices(card);
        const uniqueTokens = new Set([
            ...textIndices.name,
            ...textIndices.keywords,
            ...textIndices.ink,
            ...textIndices.classifications,
            ...textIndices.types,
            ...textIndices.text
        ]);
        for (const tokenIdx of uniqueTokens) {
            if (tokenIdx > 0) documentFrequency[tokenIdx]++;
        }
    }

    const idf = documentFrequency.map((df, idx) => {
        if (idx === 0 || df === 0) return 0;
        return Math.log(totalDocs / df);
    });

    for (const [idx, card] of indexMap.entries()) {
        const textIndices = textEmbedder.cardToTextIndices(card);
        const allTokens = [
            ...textIndices.name,
            ...textIndices.keywords,
            ...textIndices.ink,
            ...textIndices.classifications,
            ...textIndices.types,
            ...textIndices.text
        ];

        const termFrequency = new Array(textEmbedder.vocabularySize).fill(0);
        for (const tokenIdx of allTokens) {
            if (tokenIdx > 0) termFrequency[tokenIdx]++;
        }

        const tfidfVector = termFrequency.map((tf, i) => tf * idf[i]);
        const embedding = new Array(embeddingDim).fill(0);
        for (let i = 0; i < tfidfVector.length; i++) {
            const bucket = i % embeddingDim;
            embedding[bucket] += tfidfVector[i];
        }

        const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
        if (norm > 0) {
            for (let i = 0; i < embeddingDim; i++) {
                embedding[i] /= norm;
            }
        }
        card.embedding = embedding;
    }
    console.log('   ✓ Embeddings computed\n');

    // 5. Load validation model
    console.log('✅ Loading validation model...');
    const validatorModelPath = path.join(__dirname, '..', 'training_data', 'deck-validator-model');
    try {
        const numericFeatureDim = 38;
        await validationModel.initialize(textEmbedder.vocabularySize, numericFeatureDim);
        await validationModel.loadModel(validatorModelPath);
        console.log(`   ✓ Validation model loaded\n`);
    } catch (e) {
        console.error(`   ❌ Failed to load validation model: ${e.message}`);
        console.error('   Make sure you have trained the validation model first.');
        process.exit(1);
    }

    // Helper function to extract deck features
    function extractDeckFeaturesWithEmbeddings(deckIndices) {
        const features = [];
        const copyDistribution = [0, 0, 0, 0, 0];
        const cardCounts = new Map();
        for (const idx of deckIndices) {
            cardCounts.set(idx, (cardCounts.get(idx) || 0) + 1);
        }

        const uniqueCardCount = cardCounts.size;
        features.push(uniqueCardCount / 20);

        for (const count of cardCounts.values()) {
            if (count === 1) copyDistribution[0]++;
            else if (count === 2) copyDistribution[1]++;
            else if (count === 3) copyDistribution[2]++;
            else if (count === 4) copyDistribution[3]++;
            else copyDistribution[4]++;
        }
        const totalUniqueCards = [...cardCounts.keys()].length;
        copyDistribution.forEach((count) => features.push(count / Math.max(1, totalUniqueCards)));

        const costCounts = Array(10).fill(0);
        let inkableCount = 0;
        let totalCards = deckIndices.length;
        const typeCounts = { character: 0, action: 0, item: 0, location: 0 };
        const inkCounts = { Amber: 0, Amethyst: 0, Emerald: 0, Ruby: 0, Sapphire: 0, Steel: 0 };
        const keywordCounts = {
            Ward: 0, Evasive: 0, Bodyguard: 0, Resist: 0, Singer: 0,
            Shift: 0, Reckless: 0, Challenger: 0, Rush: 0
        };
        const classificationCounts = new Map();

        for (const idx of deckIndices) {
            const card = indexMap.get(idx);
            if (!card) continue;

            const costIdx = Math.min(card.cost - 1, 9);
            costCounts[costIdx]++;
            if (card.inkwell) inkableCount++;

            if (card.types && card.types.length > 0) {
                const t = card.types[0].toLowerCase();
                if (typeCounts[t] !== undefined) typeCounts[t]++;
            }

            if (card.inks && card.inks.length > 0) {
                card.inks.forEach(ink => {
                    if (inkCounts[ink] !== undefined) inkCounts[ink]++;
                });
            } else if (card.ink && inkCounts[card.ink] !== undefined) {
                inkCounts[card.ink]++;
            }

            for (const keyword of Object.keys(keywordCounts)) {
                const propName = `has${keyword}`;
                if (card[propName] || (card.keywords && card.keywords.some(k => k.includes(keyword)))) {
                    keywordCounts[keyword]++;
                }
            }

            if (card.classifications) {
                for (const cls of card.classifications) {
                    classificationCounts.set(cls, (classificationCounts.get(cls) || 0) + 1);
                }
            }
        }

        costCounts.forEach(count => features.push(count / totalCards));
        Object.values(typeCounts).forEach(count => features.push(count / totalCards));
        Object.values(inkCounts).forEach(count => features.push(count / totalCards));
        features.push(inkableCount / totalCards);
        Object.values(keywordCounts).forEach(count => features.push(count / totalCards));
        features.push(classificationCounts.size / 10);
        const avgClassificationSharing = classificationCounts.size > 0
            ? Array.from(classificationCounts.values()).reduce((a, b) => a + b, 0) / classificationCounts.size / totalCards
            : 0;
        features.push(avgClassificationSharing);

        // Add embeddings
        const embeddings = [];
        for (const idx of deckIndices) {
            const card = indexMap.get(idx);
            if (!card || !card.embedding) continue;
            embeddings.push(card.embedding);
        }

        if (embeddings.length === 0) {
            return features.concat(
                Array(embeddingDim).fill(0),
                Array(embeddingDim).fill(0),
                Array(embeddingDim).fill(0)
            );
        }

        const meanEmbedding = Array(embeddingDim).fill(0);
        const maxEmbedding = Array(embeddingDim).fill(-Infinity);

        for (const emb of embeddings) {
            for (let i = 0; i < embeddingDim; i++) {
                meanEmbedding[i] += emb[i];
                maxEmbedding[i] = Math.max(maxEmbedding[i], emb[i]);
            }
        }
        for (let i = 0; i < embeddingDim; i++) {
            meanEmbedding[i] /= embeddings.length;
        }

        const varianceEmbedding = Array(embeddingDim).fill(0);
        for (const emb of embeddings) {
            for (let i = 0; i < embeddingDim; i++) {
                const diff = emb[i] - meanEmbedding[i];
                varianceEmbedding[i] += diff * diff;
            }
        }
        for (let i = 0; i < embeddingDim; i++) {
            varianceEmbedding[i] /= embeddings.length;
        }

        return features.concat(meanEmbedding, maxEmbedding, varianceEmbedding);
    }

    // Helper to analyze deck
    function analyzeDeck(deckIndices) {
        const cardCounts = new Map();
        const inks = new Set();
        const types = new Map();
        const costCounts = Array(11).fill(0);
        let inkableCount = 0;

        for (const idx of deckIndices) {
            cardCounts.set(idx, (cardCounts.get(idx) || 0) + 1);
            const card = indexMap.get(idx);
            if (!card) continue;

            if (card.inks && card.inks.length > 0) {
                card.inks.forEach(ink => inks.add(ink));
            } else if (card.ink) {
                inks.add(card.ink);
            }
            if (card.inkwell) inkableCount++;
            costCounts[Math.min(card.cost, 10)]++;

            const cardType = (card.types && card.types.length > 0) ? card.types[0] : 'Unknown';
            types.set(cardType, (types.get(cardType) || 0) + 1);
        }

        return {
            totalCards: deckIndices.length,
            uniqueCards: cardCounts.size,
            inks: Array.from(inks),
            inkableCount,
            inkablePercent: (inkableCount / deckIndices.length) * 100,
            costCounts,
            avgCost: costCounts.reduce((sum, count, cost) => sum + count * cost, 0) / deckIndices.length,
            types: Object.fromEntries(types)
        };
    }

    // 6. Generate decks
    console.log('==================================================');
    console.log(`🎲 Generating ${numDecks} Decks`);
    console.log('==================================================\n');

    const generatedDecks = [];
    const scores = [];
    const analyses = [];

    for (let i = 0; i < numDecks; i++) {
        process.stdout.write(`Generating deck ${i + 1}/${numDecks}...`);

        const deckIndices = [];
        const deckSize = 60;
        const cardCounts = new Map();
        const temperature = 0.8; // Reduced from 1.2 to focus on higher probability cards

        // Guided Generation: Pick 2 random ink colors
        const allInks = ['Amber', 'Amethyst', 'Emerald', 'Ruby', 'Sapphire', 'Steel'];
        const selectedInks = [];
        while (selectedInks.length < 2) {
            const ink = allInks[Math.floor(Math.random() * allInks.length)];
            if (!selectedInks.includes(ink)) selectedInks.push(ink);
        }
        // process.stdout.write(` (Inks: ${selectedInks.join('/')}) `);

        let attempts = 0;
        const maxAttempts = 500; // Increased to allow for filtering

        while (deckIndices.length < deckSize && attempts < maxAttempts) {
            attempts++;

            // Get predictions from model
            const probabilities = await deckModel.predict(deckIndices);

            // Sample next card using temperature
            let selectedIdx = deckModel.sampleAction(probabilities, temperature);

            // Map from model vocab (1-indexed) to card index (0-indexed)
            if (selectedIdx === 0) continue;
            selectedIdx = selectedIdx - 1;

            // Check if card exists and is legal
            const card = indexMap.get(selectedIdx);
            if (!card || card.legality !== 'legal') {
                continue;
            }

            // CRITICAL FIX: Enforce Ink Consistency
            // Only allow cards that match our selected inks
            const cardInks = card.inks || (card.ink ? [card.ink] : []);
            if (cardInks.length > 0) {
                const isAllowed = cardInks.every(ink => selectedInks.includes(ink));
                if (!isAllowed) continue;
            }

            // Check max amount
            const copiesSoFar = cardCounts.get(selectedIdx) || 0;
            const maxAmount = card.maxAmount || 4;

            if (copiesSoFar >= maxAmount) {
                // This card already at max, try to force different prediction
                // Zero out this card's probability and re-sample
                const modifiedProbs = Array.from(probabilities);
                modifiedProbs[selectedIdx + 1] = 0;

                // Renormalize
                const sum = modifiedProbs.reduce((a, b) => a + b, 0);
                if (sum > 0) {
                    for (let j = 0; j < modifiedProbs.length; j++) {
                        modifiedProbs[j] /= sum;
                    }
                    selectedIdx = deckModel.sampleAction(modifiedProbs, temperature) - 1;

                    const retryCard = indexMap.get(selectedIdx);
                    if (!retryCard || retryCard.legality !== 'legal') continue;
                    const retryInks = retryCard.inks || (retryCard.ink ? [retryCard.ink] : []);
                    if (retryInks.length > 0 && !retryInks.every(ink => selectedInks.includes(ink))) continue;

                    const retryCopies = cardCounts.get(selectedIdx) || 0;
                    const retryMax = retryCard.maxAmount || 4;
                    if (retryCopies >= retryMax) continue;

                    // Use the retry card
                    deckIndices.push(selectedIdx);
                    cardCounts.set(selectedIdx, retryCopies + 1);
                } else {
                    continue;
                }
            } else {
                // Add card to deck
                deckIndices.push(selectedIdx);
                cardCounts.set(selectedIdx, copiesSoFar + 1);
            }
        }

        // If we didn't get 60 cards, pad with random legal cards OF THE CORRECT INK
        if (deckIndices.length < deckSize) {
            const legalCards = Array.from(indexMap.entries())
                .filter(([idx, card]) => {
                    if (card.legality !== 'legal') return false;
                    const cInks = card.inks || (card.ink ? [card.ink] : []);
                    return cInks.length === 0 || cInks.every(ink => selectedInks.includes(ink));
                })
                .map(([idx]) => idx);

            while (deckIndices.length < deckSize && legalCards.length > 0) {
                const randomIdx = legalCards[Math.floor(Math.random() * legalCards.length)];
                const copiesSoFar = cardCounts.get(randomIdx) || 0;
                const card = indexMap.get(randomIdx);
                const maxAmount = card.maxAmount || 4;

                if (copiesSoFar < maxAmount) {
                    deckIndices.push(randomIdx);
                    cardCounts.set(randomIdx, copiesSoFar + 1);
                }
            }
        }

        generatedDecks.push(deckIndices);

        // Analyze deck
        const analysis = analyzeDeck(deckIndices);
        analyses.push(analysis);

        // Score with validation model
        const features = extractDeckFeaturesWithEmbeddings(deckIndices.slice(0, 60));
        const result = await validationModel.evaluateWithBreakdown(features);
        scores.push(result.score);

        process.stdout.write(` Score: ${(result.score * 100).toFixed(1)}% (${result.grade})\n`);
    }

    // 7. Calculate statistics
    console.log('\n==================================================');
    console.log('📊 Evaluation Results');
    console.log('==================================================\n');

    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const minScore = Math.min(...scores);
    const maxScore = Math.max(...scores);
    const stdDev = Math.sqrt(
        scores.reduce((sum, score) => sum + Math.pow(score - avgScore, 2), 0) / scores.length
    );

    console.log('🎯 Validation Scores:');
    console.log(`   Average: ${(avgScore * 100).toFixed(1)}%`);
    console.log(`   Min: ${(minScore * 100).toFixed(1)}%`);
    console.log(`   Max: ${(maxScore * 100).toFixed(1)}%`);
    console.log(`   Std Dev: ${(stdDev * 100).toFixed(1)}%`);
    console.log();

    // Grade distribution
    const grades = scores.map(s => {
        if (s >= 0.85) return 'A';
        if (s >= 0.70) return 'B';
        if (s >= 0.50) return 'C';
        return 'D';
    });
    const gradeCounts = { A: 0, B: 0, C: 0, D: 0 };
    grades.forEach(g => gradeCounts[g]++);

    console.log('   Grade Distribution:');
    console.log(`     A (≥85%): ${gradeCounts.A} (${(gradeCounts.A / numDecks * 100).toFixed(0)}%)`);
    console.log(`     B (≥70%): ${gradeCounts.B} (${(gradeCounts.B / numDecks * 100).toFixed(0)}%)`);
    console.log(`     C (≥50%): ${gradeCounts.C} (${(gradeCounts.C / numDecks * 100).toFixed(0)}%)`);
    console.log(`     D (<50%): ${gradeCounts.D} (${(gradeCounts.D / numDecks * 100).toFixed(0)}%)`);
    console.log();

    // Deck quality metrics
    const avgUniqueCards = analyses.reduce((sum, a) => sum + a.uniqueCards, 0) / numDecks;
    const avgInkablePercent = analyses.reduce((sum, a) => sum + a.inkablePercent, 0) / numDecks;
    const avgCost = analyses.reduce((sum, a) => sum + a.avgCost, 0) / numDecks;
    const avgInks = analyses.reduce((sum, a) => sum + a.inks.length, 0) / numDecks;

    console.log('📈 Deck Quality Metrics:');
    console.log(`   Average unique cards: ${avgUniqueCards.toFixed(1)} (target: 15-20)`);
    console.log(`   Average inkable %: ${avgInkablePercent.toFixed(1)}% (target: >50%)`);
    console.log(`   Average cost: ${avgCost.toFixed(2)} (target: 3.5-4.5)`);
    console.log(`   Average ink colors: ${avgInks.toFixed(1)} (target: 1-2)`);
    console.log();

    // Success criteria
    console.log('✅ Success Criteria:');
    const passScore = avgScore >= 0.70;
    const passUnique = avgUniqueCards >= 15 && avgUniqueCards <= 20;
    const passInkable = avgInkablePercent >= 50;
    const passCost = avgCost >= 3.0 && avgCost <= 5.0;
    const passInks = avgInks <= 2;

    console.log(`   ${passScore ? '✅' : '❌'} Average score >70%: ${passScore ? 'PASS' : 'FAIL'} (${(avgScore * 100).toFixed(1)}%)`);
    console.log(`   ${passUnique ? '✅' : '❌'} Unique cards 15-20: ${passUnique ? 'PASS' : 'FAIL'} (${avgUniqueCards.toFixed(1)})`);
    console.log(`   ${passInkable ? '✅' : '❌'} Inkable >50%: ${passInkable ? 'PASS' : 'FAIL'} (${avgInkablePercent.toFixed(1)}%)`);
    console.log(`   ${passCost ? '✅' : '❌'} Average cost 3-5: ${passCost ? 'PASS' : 'FAIL'} (${avgCost.toFixed(2)})`);
    console.log(`   ${passInks ? '✅' : '❌'} Ink colors ≤2: ${passInks ? 'PASS' : 'FAIL'} (${avgInks.toFixed(1)})`);
    console.log();

    const overallPass = passScore && passUnique && passInkable && passCost && passInks;
    console.log('==================================================');
    console.log(overallPass ? '🎉 OVERALL: PASS' : '⚠️  OVERALL: NEEDS IMPROVEMENT');
    console.log('==================================================\n');

    // Sample deck details
    console.log('📋 Sample Deck Analysis (Deck #1):');
    const sampleAnalysis = analyses[0];
    const sampleDeck = generatedDecks[0];
    console.log(`   Score: ${(scores[0] * 100).toFixed(1)}%`);
    console.log(`   Unique cards: ${sampleAnalysis.uniqueCards}`);
    console.log(`   Inkable: ${sampleAnalysis.inkableCount}/60 (${sampleAnalysis.inkablePercent.toFixed(1)}%)`);
    console.log(`   Inks: ${sampleAnalysis.inks.join(', ')}`);
    console.log(`   Average cost: ${sampleAnalysis.avgCost.toFixed(2)}`);
    console.log(`   Types: ${Object.entries(sampleAnalysis.types).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    console.log();

    console.log('   Card list (top 10):');
    const sampleCardCounts = new Map();
    for (const idx of sampleDeck) {
        sampleCardCounts.set(idx, (sampleCardCounts.get(idx) || 0) + 1);
    }
    const sortedCards = Array.from(sampleCardCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

    for (const [idx, count] of sortedCards) {
        const card = indexMap.get(idx);
        const name = card.version ? `${card.name} - ${card.version}` : card.name;
        const inkStr = (card.inks && card.inks.length > 0) ? card.inks.join('/') : (card.ink || 'No Ink');
        console.log(`     ${count}x ${name} (${card.cost} cost, ${inkStr})`);
    }

    console.log('\n==================================================');
    console.log('Evaluation complete!');
    console.log('==================================================\n');
}

evaluateGenerator().catch(error => {
    console.error('❌ Evaluation failed:', error);
    console.error(error.stack);
    process.exit(1);
});
