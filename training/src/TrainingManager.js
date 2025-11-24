const CardApi = require('./CardApi');
const DeckModel = require('./DeckModel');
const TextEmbedder = require('./TextEmbedder');
const fs = require('fs');
const path = require('path');

module.exports = class TrainingManager {
    constructor() {
        this.cardApi = new CardApi();
        this.model = new DeckModel();
        this.textEmbedder = new TextEmbedder();
        this.cards = [];
        this.cardMap = new Map(); // Name -> Index
        this.indexMap = new Map(); // Index -> Name
        this.trainingData = [];
        this.trainingDataPath = path.join(__dirname, '..', '..', 'training_data');
        this.trainingStatePath = path.join(this.trainingDataPath, 'training-state.json');
        this.trainingState = null;
        this.loadedFiles = []; // Track files loaded in the current training session
    }

    log(message) {
        console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
    }

    async startTraining(epochs = 10, fullRetrain = false) {
        this.log(`Starting training process with ${epochs} epochs...`);
        this.log(`Mode: ${fullRetrain ? 'Full retrain' : 'Incremental training'}`);

        // Load training state
        this.loadTrainingState();
        if (fullRetrain) {
            this.log('Full retrain requested - clearing training state...');
            this.trainingState = this.getInitialTrainingState();
            this.trainingData = []; // Clear any previously cached data
        }

        // Reset loadedFiles for this session
        this.loadedFiles = [];

        // Initialize hash set for deduplication
        if (!this.trainingState.trainedDeckHashes) {
            this.trainingState.trainedDeckHashes = [];
        }
        // Convert to Set for O(1) lookups during runtime
        this.deckHashSet = new Set(this.trainingState.trainedDeckHashes);

        // 1. Fetch Cards
        if (this.cards.length === 0) {
            this.log('Fetching cards...');
            this.cards = await this.cardApi.getCards();
            this.log(`Fetched ${this.cards.length} cards.`);

            // Build Card Maps
            this.cards.forEach((card) => {
                const key = this.getCardKey(card.name, card.version);
                if (!this.cardMap.has(key)) {
                    const id = this.cardMap.size;
                    this.cardMap.set(key, id);
                    this.indexMap.set(id, card);
                }
            });
            this.log(`Unique cards indexed: ${this.cardMap.size}`);

            // Build text vocabulary
            this.log('Building text vocabulary...');
            this.textEmbedder.buildVocabulary(this.cards);
            const vocabPath = path.join(this.trainingDataPath, 'vocabulary.json');
            this.textEmbedder.save(vocabPath);
        } else {
            this.log('Cards already loaded.');
        }

        // Migration: If we have trained files but no hashes, build them now
        // We need cards loaded first to calculate hashes correctly
        if (this.deckHashSet.size === 0 && this.trainingState.trainedFiles.length > 0 && !fullRetrain) {
            const hashes = await this.buildInitialDeckHashes();
            hashes.forEach(h => this.deckHashSet.add(h));
            this.trainingState.trainedDeckHashes = hashes; // Update state immediately
            this.saveTrainingState();
        }

        // 2. Load Training Data (always attempt to load new files)
        this.log('Scanning for training data files...');
        try {
            const manifestPath = path.join(this.trainingDataPath, 'manifest.json');
            if (!fs.existsSync(manifestPath)) {
                throw new Error(`Manifest not found at ${manifestPath}`);
            }
            const allFiles = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

            // Determine which files are new this session
            const filesToTrain = fullRetrain
                ? allFiles
                : allFiles.filter(file => !this.trainingState.trainedFiles.includes(file));

            this.log(`Total files in manifest: ${allFiles.length}`);
            this.log(`Already trained files: ${this.trainingState.trainedFiles.length}`);
            this.log(`New files to train on this session: ${filesToTrain.length}`);

            if (filesToTrain.length === 0) {
                this.log('No new files to train on. All files have been processed.');
            } else {
                for (const file of filesToTrain) {
                    this.log(`Loading ${file}...`);
                    const filePath = path.join(this.trainingDataPath, file);
                    if (fs.existsSync(filePath)) {
                        const rawData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                        this.log(`Loaded tournament: ${rawData.name}`);
                        this.trainingData.push(rawData); // Append new data (won't duplicate raw objects)
                        this.loadedFiles.push(file); // Track the actual filename
                    } else {
                        this.log(`Warning: File ${file} not found.`);
                    }
                }
            }
        } catch (e) {
            this.log(`Error loading training data: ${e.message}`);
            console.error(e);
            return;
        }

        if (this.loadedFiles.length === 0) {
            this.log('No new data loaded; skipping training run.');
            return;
        }

        // 3. Process Decks
        this.log('Processing decks...');
        const sequences = [];
        const featureSequences = [];
        const textSequences = []; // NEW: text token sequences

        let processedDecks = 0;

        for (const rawData of this.trainingData.slice(-this.loadedFiles.length)) { // Only process newly loaded tournaments
            for (const deck of rawData.decks) {
                const deckIndices = [];

                for (const cardEntry of deck.cards) {
                    const key = this.getCardKey(cardEntry.name, cardEntry.version);
                    if (this.cardMap.has(key)) {
                        const index = this.cardMap.get(key);
                        for (let i = 0; i < cardEntry.amount; i++) {
                            deckIndices.push(index);
                        }
                    }
                }

                // Deduplication Check
                if (deckIndices.length > 0) {
                    const deckHash = this.getDeckHash(deckIndices);
                    if (this.deckHashSet.has(deckHash)) {
                        // Skip duplicate deck
                        continue;
                    }
                    // Add to set so we don't process it again this run (and save later)
                    this.deckHashSet.add(deckHash);

                    // Create a few shuffled versions
                    for (let k = 0; k < 5; k++) {
                        const shuffledIndices = [...deckIndices].sort(() => Math.random() - 0.5);

                        const seqIndices = [];
                        const seqFeatures = [];
                        const seqTextIndices = []; // NEW: collect text indices

                        // Initialize deck stats for this sequence
                        let currentStats = this.getInitialDeckStats();
                        const cardCounts = new Map(); // Track how many of each card

                        for (const index of shuffledIndices) {
                            const card = this.indexMap.get(index);

                            // Count this card before updating stats
                            const copiesSoFar = cardCounts.get(index) || 0;

                            this.updateDeckStats(currentStats, card);
                            const features = this.extractCardFeatures(card, currentStats, copiesSoFar);
                            const textIndices = this.textEmbedder.cardToTextIndices(card); // NEW: extract text

                            seqIndices.push(index);
                            seqFeatures.push(features);
                            seqTextIndices.push(textIndices); // NEW: collect text indices

                            // Update card count after extracting features
                            cardCounts.set(index, copiesSoFar + 1);
                        }

                        sequences.push(seqIndices);
                        featureSequences.push(seqFeatures);
                        textSequences.push(seqTextIndices); // NEW: collect text sequences
                    }
                }

                processedDecks++;
            }
        }

        this.log(`Generated ${sequences.length} sequences from ${processedDecks} newly loaded decks.`);

        if (sequences.length === 0) {
            this.log('No new training data found. Skipping training.');
            return;
        }

        // 4. Train Model
        if (!this.model.model) {
            this.log('Initializing new model...');

            // Build the static embedding matrix
            this.log('Building card embedding matrix...');
            const embeddingMatrix = this.buildCardEmbeddingMatrix();

            await this.model.initialize(
                this.cardMap.size,
                embeddingMatrix
            );
        } else {
            this.log('Continuing training on existing model...');
        }

        this.log('Training model...');

        // Helper to shuffle data arrays in sync
        const shuffleData = (seqs) => {
            const indices = seqs.map((_, i) => i);
            for (let i = indices.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [indices[i], indices[j]] = [indices[j], indices[i]];
            }
            return {
                shuffledSeqs: indices.map(i => seqs[i])
            };
        };

        // If dataset is too large, train in batches to avoid memory issues
        const MAX_BATCH_SIZE = 2000;
        if (sequences.length > MAX_BATCH_SIZE) {
            this.log(`Large dataset detected (${sequences.length} sequences). Training in batches of ${MAX_BATCH_SIZE}...`);

            // Shuffle data once before training
            this.log('Shuffling training data...');
            const { shuffledSeqs } = shuffleData(sequences);

            const numBatches = Math.ceil(sequences.length / MAX_BATCH_SIZE);

            // Outer loop: Epochs
            for (let epoch = 0; epoch < epochs; epoch++) {
                this.log(`Global Epoch ${epoch + 1}/${epochs}`);

                // Inner loop: Batches
                for (let batchIdx = 0; batchIdx < numBatches; batchIdx++) {
                    const start = batchIdx * MAX_BATCH_SIZE;
                    const end = Math.min((batchIdx + 1) * MAX_BATCH_SIZE, sequences.length);

                    const batchSequences = shuffledSeqs.slice(start, end);

                    // Train for 1 epoch per batch
                    // Note: Model.train signature must change to accept only sequences
                    await this.model.train(batchSequences, 1, (e, logs) => {
                        // Only log every 5th batch to reduce noise
                        if (batchIdx % 5 === 0 || batchIdx === numBatches - 1) {
                            this.log(`  Batch ${batchIdx + 1}/${numBatches}: loss = ${logs.loss.toFixed(4)}`);
                        }
                    });
                }
            }
        } else {
            // Normal training for smaller datasets
            await this.model.train(sequences, epochs, (epoch, logs) => {
                this.log(`Epoch ${epoch + 1}/${epochs}: loss = ${logs.loss.toFixed(4)}`);
            });
        }

        this.log('Training complete!');
        await this.saveModel();

        // Update training state
        this.updateTrainingState(epochs);
        this.saveTrainingState();
    }

    /**
     * Build a matrix of static features for all cards to initialize the embedding layer.
     * Returns array of arrays: [vocabSize, embeddingDim]
     */
    buildCardEmbeddingMatrix() {
        // We need to map card ID (1..N) to its feature vector.
        // ID 0 is padding, handled by the model initialization.
        // IDs in cardMap are 0-indexed, but model uses 1-based IDs for cards (0 is pad).
        // Actually, let's check how IDs are used.
        // In prepareTrainingData, we use this.cardMap.get(key) + 1.
        // So ID 1 corresponds to cardMap value 0.

        const matrix = [];
        // Iterate through IDs 0 to size-1
        for (let i = 0; i < this.cardMap.size; i++) {
            const card = this.indexMap.get(i);
            if (!card) {
                // Should not happen
                matrix.push(new Array(64).fill(0));
                continue;
            }

            // Extract static features
            // We'll use a simplified version of extractCardFeatures that doesn't depend on deck stats
            const features = this.extractStaticCardFeatures(card);
            matrix.push(features);
        }
        return matrix;
    }

    /**
     * Extract static features for embedding initialization.
     * Must return a fixed-size array (e.g. 64 floats).
     */
    extractStaticCardFeatures(card) {
        const features = [];

        // 1. Cost (Normalized)
        features.push(Math.min(card.cost, 10) / 10);
        // 2. Inkwell
        features.push(card.inkwell ? 1 : 0);
        // 3. Lore
        features.push(Math.min(card.lore || 0, 5) / 5);
        // 4. Strength
        features.push(Math.min(card.strength || 0, 10) / 10);
        // 5. Willpower
        features.push(Math.min(card.willpower || 0, 10) / 10);

        // 6. Inks (One-hot 6)
        const inkColors = ['Amber', 'Amethyst', 'Emerald', 'Ruby', 'Sapphire', 'Steel'];
        inkColors.forEach(ink => features.push(card.ink === ink ? 1 : 0));

        // 7. Types (One-hot 4)
        const types = ['Character', 'Action', 'Item', 'Location'];
        const cardType = (card.types && card.types.length > 0) ? card.types[0] : '';
        types.forEach(type => features.push(cardType === type ? 1 : 0));

        // 8. Keywords (10 common ones)
        const keywords = ['Bodyguard', 'Reckless', 'Rush', 'Ward', 'Evasive', 'Resist', 'Challenger', 'Singer', 'Shift', 'Support'];
        keywords.forEach(kw => {
            const hasKw = (card.keywords && card.keywords.some(k => k.includes(kw))) || (card.text && card.text.includes(kw));
            features.push(hasKw ? 1 : 0);
        });

        // 9. Classifications (5 common ones)
        const classifications = ['Hero', 'Villain', 'Dreamborn', 'Storyborn', 'Floodborn'];
        classifications.forEach(cls => {
            features.push(card.classifications && card.classifications.includes(cls) ? 1 : 0);
        });

        // Current feature count: 1+1+1+1+1 + 6 + 4 + 10 + 5 = 30 features.

        // 10. Text Embedding (34 dimensions to reach 64 total)
        // We use a simple hash-based embedding of the text/name
        const textEmbedding = this.computeSimpleTextEmbedding(card, 34);
        features.push(...textEmbedding);

        return features;
    }

    computeSimpleTextEmbedding(card, dim) {
        const text = `${card.name} ${card.text || ''} ${card.keywords ? card.keywords.join(' ') : ''}`.toLowerCase();
        const embedding = new Array(dim).fill(0);
        for (let i = 0; i < text.length; i++) {
            const charCode = text.charCodeAt(i);
            embedding[charCode % dim] += 1;
        }
        // Normalize
        const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
        if (norm > 0) {
            for (let i = 0; i < dim; i++) embedding[i] /= norm;
        }
        return embedding;
    }

    getInitialTrainingState() {
        return {
            lastTrainingDate: null,
            totalTrainings: 0,
            trainedFiles: [],
            trainedDeckHashes: [], // Store hashes of all trained decks
            trainingHistory: []
        };
    }

    loadTrainingState() {
        if (fs.existsSync(this.trainingStatePath)) {
            try {
                this.trainingState = JSON.parse(fs.readFileSync(this.trainingStatePath, 'utf8'));
                this.log(`Loaded training state: ${this.trainingState.trainedFiles.length} files previously trained`);
            } catch (e) {
                this.log(`Warning: Could not load training state: ${e.message}`);
                this.trainingState = this.getInitialTrainingState();
            }
        } else {
            this.log('No existing training state found. Starting fresh.');
            this.trainingState = this.getInitialTrainingState();
        }
    }

    updateTrainingState(epochs) {
        const now = new Date().toISOString();
        // Use loadedFiles directly; they are the actual filenames for new data this session
        const newFiles = this.loadedFiles.filter(f => !this.trainingState.trainedFiles.includes(f));

        // Add new files to trained files list
        this.trainingState.trainedFiles.push(...newFiles);

        // Update training history
        this.trainingState.trainingHistory.push({
            date: now,
            epochs: epochs,
            newFiles: newFiles.length,
            totalFiles: this.trainingState.trainedFiles.length
        });

        this.trainingState.lastTrainingDate = now;
        this.trainingState.totalTrainings++;

        this.log(`Updated training state: ${newFiles.length} new files added (session files: ${this.loadedFiles.length}).`);

        // Save updated hashes
        this.trainingState.trainedDeckHashes = Array.from(this.deckHashSet);
    }

    saveTrainingState() {
        try {
            fs.writeFileSync(this.trainingStatePath, JSON.stringify(this.trainingState, null, 2));
            this.log(`Training state saved to ${this.trainingStatePath}`);
        } catch (e) {
            this.log(`Error saving training state: ${e.message}`);
        }
    }

    getInitialDeckStats() {
        return {
            totalCards: 0,
            inkableCount: 0,
            costCounts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // Costs 1-10
            inkableCostCounts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // Inkable cards at costs 1-10
            typeCounts: {
                'character': 0,
                'action': 0,
                'item': 0,
                'location': 0
            },
            inkCounts: {
                'Amber': 0,
                'Amethyst': 0,
                'Emerald': 0,
                'Ruby': 0,
                'Sapphire': 0,
                'Steel': 0
            }
        };
    }

    updateDeckStats(stats, card) {
        stats.totalCards++;
        if (card.inkwell) stats.inkableCount++;

        // Map cost to index: costs 1-10 -> indices 0-9, cost 0 or >10 -> capped
        let cIdx = Math.max(0, Math.min(card.cost - 1, 9)); // cost 1->0, cost 10->9, cost 0->0 (capped)
        if (card.cost === 0) cIdx = 0; // Treat cost 0 as cost 1 bucket
        stats.costCounts[cIdx]++;

        // Track inkable cards per cost
        if (card.inkwell) {
            stats.inkableCostCounts[cIdx]++;
        }

        // Track ink color distribution
        if (card.ink) {
            if (!stats.inkCounts[card.ink]) {
                stats.inkCounts[card.ink] = 0;
            }
            stats.inkCounts[card.ink]++;
        }

        // Track type distribution with safety check
        if (card.type) {
            const t = card.type.toLowerCase();
            if (stats.typeCounts[t] !== undefined) {
                stats.typeCounts[t]++;
            }
        }
    }

    extractCardFeatures(card, stats, copiesSoFar = 0) {
        const features = [];

        // --- Static Features ---
        features.push(Math.min(card.cost, 10) / 10); // Cost
        features.push(card.inkwell ? 1 : 0); // Inkwell
        features.push(Math.min(card.lore || 0, 5) / 5); // Lore
        features.push(Math.min(card.strength || 0, 10) / 10); // Strength
        features.push(Math.min(card.willpower || 0, 10) / 10); // Willpower

        // Inks (One-hot)
        const inkColors = ['Amber', 'Amethyst', 'Emerald', 'Ruby', 'Sapphire', 'Steel'];
        inkColors.forEach(ink => {
            features.push(card.ink === ink ? 1 : 0);
        });

        // Types (One-hot)
        const types = ['Character', 'Action', 'Item', 'Location'];
        const cardType = (card.types && card.types.length > 0) ? card.types[0] : '';
        types.forEach(type => {
            features.push(cardType === type ? 1 : 0);
        });

        // Keyword Booleans
        const keywords = ['Bodyguard', 'Reckless', 'Rush', 'Ward', 'Evasive', 'Resist', 'Challenger', 'Singer', 'Shift', 'Boost'];
        keywords.forEach(kw => {
            const propName = `has${kw}`;
            if (card[propName] !== undefined) {
                features.push(card[propName] ? 1 : 0);
            } else {
                const hasKw = card.keywords && card.keywords.some(k => k.includes(kw));
                features.push(hasKw ? 1 : 0);
            }
        });

        // Keyword Amounts
        features.push(Math.min(card.resistAmount || 0, 10) / 10);
        features.push(Math.min(card.challengerAmount || 0, 10) / 10);
        features.push(Math.min(card.boostAmount || 0, 10) / 10);

        // Move Cost
        features.push(Math.min(card.moveCost || 0, 10) / 10);

        // Classifications
        const commonClassifications = ['Hero', 'Villain', 'Dreamborn', 'Storyborn', 'Floodborn'];
        commonClassifications.forEach(cls => {
            features.push(card.classifications && card.classifications.includes(cls) ? 1 : 0);
        });

        // Copies so far
        features.push(Math.min(copiesSoFar, 4) / 4);

        // Dynamic features
        const total = Math.max(1, stats.totalCards);
        features.push(stats.inkableCount / total); // Inkable fraction
        stats.costCounts.forEach(count => { features.push(count / total); }); // Cost curve
        Object.values(stats.typeCounts).forEach(count => { features.push(count / total); }); // Type distribution
        inkColors.forEach(ink => { features.push((stats.inkCounts[ink] || 0) / total); }); // Ink color distribution
        stats.inkableCostCounts.forEach(count => { features.push(count / total); }); // Inkable cost curve

        return features;
    }

    async saveModel() {
        this.log('Saving model to disk...');
        const modelPath = path.join(this.trainingDataPath, 'deck-generator-model');
        await this.model.saveModel(modelPath);
        this.log(`Model saved to ${modelPath}`);
    }

    getCardKey(name, version) {
        return `${name}|${version || ''}`.toLowerCase();
    }

    /**
     * Calculate a unique hash for a deck based on its content
     * Sorts cards by ID and creates a string signature: "id:count|id:count|..."
     */
    getDeckHash(deckIndices) {
        // Count cards
        const counts = new Map();
        for (const idx of deckIndices) {
            counts.set(idx, (counts.get(idx) || 0) + 1);
        }

        // Sort by ID to ensure consistent order
        const sortedIds = Array.from(counts.keys()).sort((a, b) => a - b);

        // Build hash string
        return sortedIds.map(id => `${id}:${counts.get(id)}`).join('|');
    }

    /**
     * Build hash set from all previously trained files (Migration)
     */
    async buildInitialDeckHashes() {
        this.log('Building initial deck hashes from history (Migration)...');
        const hashes = new Set();
        let totalDecks = 0;

        for (const file of this.trainingState.trainedFiles) {
            const filePath = path.join(this.trainingDataPath, file);
            if (fs.existsSync(filePath)) {
                try {
                    const rawData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    for (const deck of rawData.decks) {
                        const deckIndices = [];
                        for (const cardEntry of deck.cards) {
                            const key = this.getCardKey(cardEntry.name, cardEntry.version);
                            if (this.cardMap.has(key)) {
                                const index = this.cardMap.get(key);
                                for (let i = 0; i < cardEntry.amount; i++) {
                                    deckIndices.push(index);
                                }
                            }
                        }
                        if (deckIndices.length > 0) {
                            hashes.add(this.getDeckHash(deckIndices));
                            totalDecks++;
                        }
                    }
                } catch (e) {
                    this.log(`Warning: Could not read ${file} for hash migration: ${e.message}`);
                }
            }
        }
        this.log(`Migration complete. Indexed ${hashes.size} unique decks from ${totalDecks} total decks.`);
        return Array.from(hashes);
    }

    /**
     * Extract deck-level features for validation model
     */
    extractDeckFeatures(deckIndices) {
        const features = [];

        // Count cards by copy amount (0-9)
        const copyDistribution = [0, 0, 0, 0, 0]; // 1 copy, 2 copies, 3 copies, 4 copies, >4 copies
        const cardCounts = new Map();
        for (const idx of deckIndices) {
            cardCounts.set(idx, (cardCounts.get(idx) || 0) + 1);
        }

        // CRITICAL FIX: Add unique card count as first feature
        // Tournament decks typically have 15-20 unique cards
        const uniqueCardCount = cardCounts.size;
        features.push(uniqueCardCount / 20); // Normalize by typical deck diversity

        for (const count of cardCounts.values()) {
            if (count === 1) copyDistribution[0]++;
            else if (count === 2) copyDistribution[1]++;
            else if (count === 3) copyDistribution[2]++;
            else if (count === 4) copyDistribution[3]++;
            else copyDistribution[4]++;
        }
        // Normalize
        const totalUniqueCards = [...cardCounts.keys()].length;
        copyDistribution.forEach((count, i) => features.push(count / Math.max(1, totalUniqueCards)));

        // Mana curve distribution (costs 1-10)
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
            const card = this.indexMap.get(idx);
            if (!card) continue;

            // Mana curve
            const costIdx = Math.min(card.cost - 1, 9);
            costCounts[costIdx]++;

            // Inkable
            if (card.inkwell) inkableCount++;

            // Type
            if (card.types && card.types.length > 0) {
                const t = card.types[0].toLowerCase();
                if (typeCounts[t] !== undefined) typeCounts[t]++;
            }

            // Ink color
            if (card.ink && inkCounts[card.ink] !== undefined) {
                inkCounts[card.ink]++;
            }

            // Keywords
            for (const keyword of Object.keys(keywordCounts)) {
                const propName = `has${keyword}`;
                if (card[propName] || (card.keywords && card.keywords.some(k => k.includes(keyword)))) {
                    keywordCounts[keyword]++;
                }
            }

            // Classifications
            if (card.classifications) {
                for (const cls of card.classifications) {
                    classificationCounts.set(cls, (classificationCounts.get(cls) || 0) + 1);
                }
            }
        }

        // Add mana curve (normalized)
        costCounts.forEach(count => features.push(count / totalCards));

        // Add type distribution
        Object.values(typeCounts).forEach(count => features.push(count / totalCards));

        // Add ink distribution
        Object.values(inkCounts).forEach(count => features.push(count / totalCards));

        // Add inkable ratio
        features.push(inkableCount / totalCards);

        // Add keyword distribution
        Object.values(keywordCounts).forEach(count => features.push(count / totalCards));

        // Add classification diversity (how many different classifications)
        features.push(classificationCounts.size / 10); // Normalize by ~10 possible classifications

        // Add synergy score (how many cards share classifications)
        const avgClassificationSharing = classificationCounts.size > 0
            ? Array.from(classificationCounts.values()).reduce((a, b) => a + b, 0) / classificationCounts.size / totalCards
            : 0;
        features.push(avgClassificationSharing);

        return features;
    }

    /**
     * Extract deck features including aggregated text embeddings
     * Returns: [numeric features (38), mean embeddings (32), max embeddings (32), variance embeddings (32)]
     */
    extractDeckFeaturesWithEmbeddings(deckIndices) {
        // Get numeric features
        const numericFeatures = this.extractDeckFeatures(deckIndices);

        // Get embeddings for each card
        const embeddings = [];
        for (const idx of deckIndices) {
            const card = this.indexMap.get(idx);
            if (!card || !card.embedding) continue;
            embeddings.push(card.embedding);
        }

        if (embeddings.length === 0) {
            // No embeddings available, return zeros
            const embeddingDim = 32;
            return numericFeatures.concat(
                Array(embeddingDim).fill(0), // mean
                Array(embeddingDim).fill(0), // max
                Array(embeddingDim).fill(0)  // variance
            );
        }

        const embeddingDim = embeddings[0].length;
        const meanEmbedding = Array(embeddingDim).fill(0);
        const maxEmbedding = Array(embeddingDim).fill(-Infinity);

        // Compute mean and max
        for (const emb of embeddings) {
            for (let i = 0; i < embeddingDim; i++) {
                meanEmbedding[i] += emb[i];
                maxEmbedding[i] = Math.max(maxEmbedding[i], emb[i]);
            }
        }
        for (let i = 0; i < embeddingDim; i++) {
            meanEmbedding[i] /= embeddings.length;
        }

        // Compute variance
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

        return numericFeatures.concat(meanEmbedding, maxEmbedding, varianceEmbedding);
    }


    /**
     * Generate fake decks for validation model training
     */
    generateFakeDeck(strategy = 'random') {
        const deckIndices = [];
        const deckSize = 60;

        if (strategy === 'pure_random') {
            // Strategy A: Pure random (30% of fakes)
            const cardPool = Array.from(this.cardMap.values());
            const cardCounts = new Map();

            while (deckIndices.length < deckSize) {
                const randomIdx = cardPool[Math.floor(Math.random() * cardPool.length)];
                const currentCount = cardCounts.get(randomIdx) || 0;
                const card = this.indexMap.get(randomIdx);
                const maxAmount = card?.maxAmount || 4;

                if (currentCount < maxAmount) {
                    deckIndices.push(randomIdx);
                    cardCounts.set(randomIdx, currentCount + 1);
                }
            }
        } else if (strategy === 'ink_constrained') {
            // Strategy B: Ink-constrained random (25% of fakes)
            const inks = ['Amber', 'Amethyst', 'Emerald', 'Ruby', 'Sapphire', 'Steel'];
            const chosenInks = [];
            const inkCount = Math.random() < 0.5 ? 1 : 2;
            for (let i = 0; i < inkCount; i++) {
                const ink = inks[Math.floor(Math.random() * inks.length)];
                if (!chosenInks.includes(ink)) chosenInks.push(ink);
            }

            const cardPool = [];
            for (const [idx, card] of this.indexMap.entries()) {
                if (chosenInks.includes(card.ink)) {
                    cardPool.push(idx);
                }
            }

            const cardCounts = new Map();
            while (deckIndices.length < deckSize && cardPool.length > 0) {
                const randomIdx = cardPool[Math.floor(Math.random() * cardPool.length)];
                const currentCount = cardCounts.get(randomIdx) || 0;
                const card = this.indexMap.get(randomIdx);
                const maxAmount = card?.maxAmount || 4;

                if (currentCount < maxAmount) {
                    deckIndices.push(randomIdx);
                    cardCounts.set(randomIdx, currentCount + 1);
                }
            }
        } else if (strategy === 'rule_broken') {
            // Strategy C: Rule-broken DeckGenerator style (25% of fakes)
            // Use flat mana curve and allow excessive singletons
            const inks = ['Amber', 'Amethyst', 'Emerald', 'Ruby', 'Sapphire', 'Steel'];
            const chosenInks = [];
            const inkCount = Math.random() < 0.5 ? 1 : 2;
            for (let i = 0; i < inkCount; i++) {
                const ink = inks[Math.floor(Math.random() * inks.length)];
                if (!chosenInks.includes(ink)) chosenInks.push(ink);
            }

            const cardPool = [];
            for (const [idx, card] of this.indexMap.entries()) {
                if (chosenInks.includes(card.ink)) {
                    cardPool.push(idx);
                }
            }

            // Flat distribution (not bell curve)
            const costs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
            const cardCounts = new Map();
            let singletonCount = 0;

            for (let i = 0; i < deckSize; i++) {
                // Pick random cost with uniform distribution
                const targetCost = costs[Math.floor(Math.random() * costs.length)];
                const cardsOfCost = cardPool.filter(idx => {
                    const card = this.indexMap.get(idx);
                    return card && card.cost === targetCost;
                });

                if (cardsOfCost.length > 0) {
                    let attempts = 0;
                    let picked = false;
                    while (!picked && attempts < 10) {
                        const randomIdx = cardsOfCost[Math.floor(Math.random() * cardsOfCost.length)];
                        const currentCount = cardCounts.get(randomIdx) || 0;
                        const card = this.indexMap.get(randomIdx);
                        const maxAmount = card?.maxAmount || 4;

                        // Allow more singletons by biasing toward single copies
                        const shouldAddCopy = currentCount === 0 || (Math.random() < 0.3 && currentCount < maxAmount);

                        if (shouldAddCopy && currentCount < maxAmount) {
                            deckIndices.push(randomIdx);
                            if (currentCount === 0) singletonCount++;
                            cardCounts.set(randomIdx, currentCount + 1);
                            picked = true;
                        }
                        attempts++;
                    }
                }
            }

            // Pad if needed
            while (deckIndices.length < deckSize) {
                const randomIdx = cardPool[Math.floor(Math.random() * cardPool.length)];
                deckIndices.push(randomIdx);
            }
        } else if (strategy === 'low_diversity') {
            // Strategy D: Low diversity - only 1-5 unique cards (20% of fakes)
            // This catches decks like "60 Dalmatian Puppies"
            const cardPool = Array.from(this.cardMap.values());
            const numUniqueCards = Math.floor(Math.random() * 5) + 1; // 1-5 unique cards
            const selectedCards = [];

            // Pick random unique cards
            while (selectedCards.length < numUniqueCards) {
                const randomIdx = cardPool[Math.floor(Math.random() * cardPool.length)];
                if (!selectedCards.includes(randomIdx)) {
                    selectedCards.push(randomIdx);
                }
            }

            // Fill deck by repeating these cards
            for (let i = 0; i < deckSize; i++) {
                const randomCard = selectedCards[Math.floor(Math.random() * selectedCards.length)];
                deckIndices.push(randomCard);
            }
        }
        return deckIndices.slice(0, deckSize);
    }

    /**
     * Generate a partial deck by removing 10-20 random cards from a tournament deck
     * @param {Array} baseDeckIndices - Full tournament deck indices (60 cards)
     * @returns {Array} Partial deck indices (40-50 cards)
     */
    generatePartialDeck(baseDeckIndices) {
        // Remove between 10-20 cards randomly
        const cardsToRemove = Math.floor(Math.random() * 11) + 10; // 10-20
        const deckCopy = [...baseDeckIndices];

        for (let i = 0; i < cardsToRemove; i++) {
            const randomIndex = Math.floor(Math.random() * deckCopy.length);
            deckCopy.splice(randomIndex, 1);
        }

        return deckCopy;
    }

    /**
     * Complete a partial deck to 60 cards using weighted card selection
     * Similar to DeckGenerator logic but simpler
     * @param {Array} partialDeckIndices - Partial deck indices (40-50 cards)
     * @returns {Array} Completed deck indices (60 cards)
     */
    completePartialDeckWithGenerator(partialDeckIndices) {
        const deck = [...partialDeckIndices];
        const targetSize = 60;

        // Analyze existing deck
        const cardCounts = new Map();
        const inks = new Set();
        const costCounts = Array(10).fill(0);

        for (const idx of deck) {
            cardCounts.set(idx, (cardCounts.get(idx) || 0) + 1);
            const card = this.indexMap.get(idx);
            if (card) {
                if (card.ink) inks.add(card.ink);
                const costIdx = Math.min(card.cost - 1, 9);
                costCounts[costIdx]++;
            }
        }

        // Get card pool matching the deck's inks
        const inkArray = Array.from(inks);
        const cardPool = [];
        for (const [idx, card] of this.indexMap.entries()) {
            if (inkArray.includes(card.ink) && card.legality === 'legal') {
                cardPool.push(idx);
            }
        }

        if (cardPool.length === 0) {
            // Fallback: use all cards
            for (const idx of this.cardMap.values()) {
                cardPool.push(idx);
            }
        }

        // Complete the deck
        let attempts = 0;
        const maxAttempts = 200;

        while (deck.length < targetSize && attempts < maxAttempts) {
            // Pick a random cost based on what's missing
            const totalCards = deck.length;
            const avgCost = costCounts.reduce((sum, count, idx) => sum + count * (idx + 1), 0) / Math.max(1, totalCards);

            // Prefer costs around 2-4 for completion
            const targetCost = Math.floor(Math.random() * 4) + 2; // Costs 2-5

            // Find cards of that cost
            const cardsOfCost = cardPool.filter(idx => {
                const card = this.indexMap.get(idx);
                return card && card.cost === targetCost;
            });

            if (cardsOfCost.length > 0) {
                // Pick a random card
                const randomIdx = cardsOfCost[Math.floor(Math.random() * cardsOfCost.length)];
                const currentCount = cardCounts.get(randomIdx) || 0;
                const card = this.indexMap.get(randomIdx);
                const maxAmount = card?.maxAmount || 4;

                if (currentCount < maxAmount) {
                    deck.push(randomIdx);
                    cardCounts.set(randomIdx, currentCount + 1);
                    const costIdx = Math.min(card.cost - 1, 9);
                    costCounts[costIdx]++;
                }
            } else {
                // Fallback: pick any random card
                const randomIdx = cardPool[Math.floor(Math.random() * cardPool.length)];
                const currentCount = cardCounts.get(randomIdx) || 0;
                const card = this.indexMap.get(randomIdx);
                const maxAmount = card?.maxAmount || 4;

                if (currentCount < maxAmount) {
                    deck.push(randomIdx);
                    cardCounts.set(randomIdx, currentCount + 1);
                }
            }

            attempts++;
        }

        // Pad if still not 60 (shouldn't happen, but safety)
        while (deck.length < targetSize) {
            const randomIdx = cardPool[Math.floor(Math.random() * cardPool.length)];
            deck.push(randomIdx);
        }

        return deck.slice(0, 60); // Ensure exactly 60
    }

    /**
     * Prepare validation dataset with aggregated embedding features
     */
    prepareValidationDataset() {
        this.log('Preparing validation dataset...');
        const features = [];
        const labels = [];

        // Get real decks from training data
        let realDeckCount = 0;
        const realDeckIndices = []; // Store for partial deck generation

        for (const rawData of this.trainingData) {
            for (const deck of rawData.decks) {
                const deckIndices = [];
                for (const cardEntry of deck.cards) {
                    const key = this.getCardKey(cardEntry.name, cardEntry.version);
                    if (this.cardMap.has(key)) {
                        const index = this.cardMap.get(key);
                        for (let i = 0; i < cardEntry.amount; i++) {
                            deckIndices.push(index);
                        }
                    }
                }

                if (deckIndices.length >= 60) {
                    const fullDeck = deckIndices.slice(0, 60);
                    const deckFeatures = this.extractDeckFeaturesWithEmbeddings(fullDeck);
                    features.push(deckFeatures);

                    // SCORING LOGIC BASED ON TOURNAMENT PLACEMENT
                    // User request: Place 1 should get higher score than Place 16.
                    // Formula: Start at 1.0, deduct 0.02 per place below 1st. Floor at 0.6.
                    // If place is missing, assume it's a valid tournament deck (0.85).
                    let score = 0.85;
                    if (deck.place) {
                        score = Math.max(0.6, 1.0 - (deck.place - 1) * 0.02);
                    }
                    labels.push(score);
                    realDeckCount++;

                    // Store for partial deck generation
                    realDeckIndices.push(fullDeck);
                }
            }
        }

        this.log(`Extracted ${realDeckCount} real decks`);

        // Generate partial decks from real tournament decks
        // Generate 1-2 variants per tournament deck
        let partialDeckCount = 0;
        for (const baseDeck of realDeckIndices) {
            const numVariants = Math.random() < 0.5 ? 1 : 2; // 50% chance of 1 or 2 variants

            for (let v = 0; v < numVariants; v++) {
                const partialDeck = this.generatePartialDeck(baseDeck);
                const completedDeck = this.completePartialDeckWithGenerator(partialDeck);
                const deckFeatures = this.extractDeckFeaturesWithEmbeddings(completedDeck);
                features.push(deckFeatures);
                labels.push(0.6); // Medium quality score
                partialDeckCount++;
            }
        }

        this.log(`Generated ${partialDeckCount} partial decks (medium quality)`);

        // Generate fake decks (equal number to real decks) using 4 strategies
        const strategies = ['pure_random', 'ink_constrained', 'rule_broken', 'low_diversity'];
        const strategyCounts = {
            'pure_random': Math.floor(realDeckCount * 0.30),
            'ink_constrained': Math.floor(realDeckCount * 0.25),
            'rule_broken': Math.floor(realDeckCount * 0.25),
            'low_diversity': Math.floor(realDeckCount * 0.20)
        };

        for (const [strategy, count] of Object.entries(strategyCounts)) {
            for (let i = 0; i < count; i++) {
                const fakeDeck = this.generateFakeDeck(strategy);
                const deckFeatures = this.extractDeckFeaturesWithEmbeddings(fakeDeck.slice(0, 60));
                features.push(deckFeatures);
                labels.push(0); // Fake deck
            }
        }

        this.log(`Generated ${realDeckCount} fake decks`);
        this.log(`Total dataset size: ${features.length} decks (${realDeckCount} real + ${partialDeckCount} partial + ${realDeckCount} fake)`);
        this.log(`Feature dimension: ${features[0].length} (38 numeric + 96 embedding stats)`);

        return { features, labels };
    }
};
