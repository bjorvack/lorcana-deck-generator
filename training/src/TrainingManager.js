const CardApi = require('./CardApi');
const DeckModel = require('./DeckModel');
const fs = require('fs');
const path = require('path');

module.exports = class TrainingManager {
    constructor() {
        this.cardApi = new CardApi();
        this.model = new DeckModel();
        this.cards = [];
        this.cardMap = new Map(); // Name -> Index
        this.indexMap = new Map(); // Index -> Name
        this.trainingData = [];
        this.trainingDataPath = path.join(__dirname, '..', '..', 'training_data');
        this.trainingStatePath = path.join(this.trainingDataPath, 'training-state.json');
        this.trainingState = null;
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
        }

        // 1. Fetch Cards
        if (this.cards.length === 0) {
            this.log('Fetching cards...');
            this.cards = await this.cardApi.getCards();
            this.log(`Fetched ${this.cards.length} cards.`);

            // Build Card Maps
            this.cards.forEach((card, index) => {
                const key = this.getCardKey(card.name, card.version);
                if (!this.cardMap.has(key)) {
                    const id = this.cardMap.size;
                    this.cardMap.set(key, id);
                    this.indexMap.set(id, card);
                }
            });
            this.log(`Unique cards indexed: ${this.cardMap.size}`);
        } else {
            this.log('Cards already loaded.');
        }

        // 2. Load Training Data
        if (this.trainingData.length === 0) {
            this.log('Loading training data...');

            try {
                const manifestPath = path.join(this.trainingDataPath, 'manifest.json');
                if (!fs.existsSync(manifestPath)) {
                    throw new Error(`Manifest not found at ${manifestPath}`);
                }
                const allFiles = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

                // Filter files based on training state
                const filesToTrain = fullRetrain
                    ? allFiles
                    : allFiles.filter(file => !this.trainingState.trainedFiles.includes(file));

                this.log(`Total files in manifest: ${allFiles.length}`);
                this.log(`Already trained files: ${this.trainingState.trainedFiles.length}`);
                this.log(`New files to train on: ${filesToTrain.length}`);

                if (filesToTrain.length === 0) {
                    this.log('No new files to train on. All files have been processed.');
                    return;
                }

                for (const file of filesToTrain) {
                    this.log(`Loading ${file}...`);
                    const filePath = path.join(this.trainingDataPath, file);
                    if (fs.existsSync(filePath)) {
                        const rawData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                        this.log(`Loaded tournament: ${rawData.name}`);
                        this.trainingData.push(rawData);
                    } else {
                        this.log(`Warning: File ${file} not found.`);
                    }
                }
            } catch (e) {
                this.log(`Error loading training data: ${e.message}`);
                console.error(e);
                return;
            }
        } else {
            this.log('Training data already loaded.');
        }

        // 3. Process Decks
        this.log('Processing decks...');
        const sequences = [];
        const featureSequences = [];

        let processedDecks = 0;

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

                if (deckIndices.length > 0) {
                    // Create a few shuffled versions
                    for (let k = 0; k < 5; k++) {
                        const shuffledIndices = [...deckIndices].sort(() => Math.random() - 0.5);

                        const seqIndices = [];
                        const seqFeatures = [];

                        // Initialize deck stats for this sequence
                        let currentStats = this.getInitialDeckStats();
                        const cardCounts = new Map(); // Track how many of each card

                        for (const index of shuffledIndices) {
                            const card = this.indexMap.get(index);

                            // Count this card before updating stats
                            const copiesSoFar = cardCounts.get(index) || 0;

                            this.updateDeckStats(currentStats, card);
                            const features = this.extractCardFeatures(card, currentStats, copiesSoFar);

                            seqIndices.push(index);
                            seqFeatures.push(features);

                            // Update card count after extracting features
                            cardCounts.set(index, copiesSoFar + 1);
                        }

                        sequences.push(seqIndices);
                        featureSequences.push(seqFeatures);
                    }
                }

                processedDecks++;
            }
        }

        this.log(`Generated ${sequences.length} sequences from ${processedDecks} decks.`);

        // 4. Train Model
        if (!this.model.model) {
            this.log('Initializing new model...');
            // We need to know feature dimension
            const featureDim = featureSequences[0][0].length;
            await this.model.initialize(this.cardMap.size, featureDim);
        } else {
            this.log('Continuing training on existing model...');
        }

        this.log('Training model...');
        await this.model.train(sequences, featureSequences, epochs, (epoch, logs) => {
            this.log(`Epoch ${epoch + 1}/${epochs}: loss = ${logs.loss.toFixed(4)}`);
        });

        this.log('Training complete!');
        await this.saveModel();

        // Update training state
        this.updateTrainingState(epochs);
        this.saveTrainingState();
    }

    getInitialTrainingState() {
        return {
            lastTrainingDate: null,
            totalTrainings: 0,
            trainedFiles: [],
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
        const newFiles = this.trainingData.map(td => {
            // Extract filename from tournament data
            // We need to reconstruct it from the manifest
            const manifestPath = path.join(this.trainingDataPath, 'manifest.json');
            const allFiles = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            return allFiles.find(f => {
                const filePath = path.join(this.trainingDataPath, f);
                if (fs.existsSync(filePath)) {
                    const rawData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    return rawData.name === td.name && rawData.url === td.url;
                }
                return false;
            });
        }).filter(f => f && !this.trainingState.trainedFiles.includes(f));

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

        this.log(`Updated training state: ${newFiles.length} new files added`);
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

        // 1. Cost (Normalized 0-10 -> 0-1)
        features.push(Math.min(card.cost, 10) / 10);

        // 2. Inkwell (0 or 1)
        features.push(card.inkwell ? 1 : 0);

        // 3. Lore (Normalized 0-5)
        features.push(Math.min(card.lore || 0, 5) / 5);

        // 4. Strength (Normalized 0-10)
        features.push(Math.min(card.strength || 0, 10) / 10);

        // 5. Willpower (Normalized 0-10)
        features.push(Math.min(card.willpower || 0, 10) / 10);

        // 6. Inks (One-hot)
        const inkColors = ['Amber', 'Amethyst', 'Emerald', 'Ruby', 'Sapphire', 'Steel'];
        inkColors.forEach(ink => {
            features.push(card.ink === ink ? 1 : 0);
        });

        // 7. Types (One-hot)
        const types = ['Character', 'Action', 'Item', 'Location'];
        const cardType = (card.types && card.types.length > 0) ? card.types[0] : '';
        types.forEach(type => {
            features.push(cardType === type ? 1 : 0);
        });

        // 8. Keyword Booleans (10 features)
        const keywords = ['Bodyguard', 'Reckless', 'Rush', 'Ward', 'Evasive', 'Resist', 'Challenger', 'Singer', 'Shift', 'Boost'];
        keywords.forEach(kw => {
            const propName = `has${kw}`;
            if (card[propName] !== undefined) {
                features.push(card[propName] ? 1 : 0);
            } else {
                // Fallback to checking keywords array
                const hasKw = card.keywords && card.keywords.some(k => k.includes(kw));
                features.push(hasKw ? 1 : 0);
            }
        });

        // 9. Keyword Amounts (3 features)
        features.push(Math.min(card.resistAmount || 0, 10) / 10);      // Resist +X
        features.push(Math.min(card.challengerAmount || 0, 10) / 10);  // Challenger +X
        features.push(Math.min(card.boostAmount || 0, 10) / 10);       // Boost +X

        // 10. Move Cost (1 feature)
        features.push(Math.min(card.moveCost || 0, 10) / 10);

        // 11. Classifications (5 features) - Common card classifications
        const commonClassifications = ['Hero', 'Villain', 'Dreamborn', 'Storyborn', 'Floodborn'];
        commonClassifications.forEach(cls => {
            features.push(card.classifications && card.classifications.includes(cls) ? 1 : 0);
        });

        // 12. Copies of this card so far (NEW FEATURE)
        features.push(Math.min(copiesSoFar, 4) / 4);

        // --- Dynamic Features (Deck Composition) ---
        const total = Math.max(1, stats.totalCards);

        // 13. Inkable Fraction
        features.push(stats.inkableCount / total);

        // 14. Cost Curve (Fractions) - 10 costs
        stats.costCounts.forEach(count => {
            features.push(count / total);
        });

        // 15. Type Distribution (Fractions)
        Object.values(stats.typeCounts).forEach(count => {
            features.push(count / total);
        });

        // 16. Ink Color Distribution (Fractions)
        const inks = ['Amber', 'Amethyst', 'Emerald', 'Ruby', 'Sapphire', 'Steel'];
        inks.forEach(ink => {
            features.push((stats.inkCounts[ink] || 0) / total);
        });

        // 17. Inkable Cost Curve (Fractions) - 10 costs
        stats.inkableCostCounts.forEach(count => {
            features.push(count / total);
        });

        return features;
    }

    async saveModel() {
        this.log('Saving model to disk...');
        const modelPath = path.join(this.trainingDataPath, 'deck-generator-model');
        await this.model.saveModel(modelPath);
        this.log(`Model saved to ${modelPath}`);
    }

    getCardKey(name, version) {
        // Normalize key
        return `${name}|${version || ''}`.toLowerCase();
    }
}
