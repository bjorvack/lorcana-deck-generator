import CardApi from './CardApi';
import DeckModel from './DeckModel';

export default class TrainingManager {
    constructor() {
        this.cardApi = new CardApi();
        this.model = new DeckModel();
        this.cards = [];
        this.cardMap = new Map(); // Name -> Index
        this.indexMap = new Map(); // Index -> Name
        this.trainingData = [];
    }

    log(message) {
        const logEl = document.getElementById('status-log');
        if (logEl) {
            const div = document.createElement('div');
            div.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
            logEl.appendChild(div);
            logEl.scrollTop = logEl.scrollHeight;
        }
        console.log(message);
    }

    async startTraining() {
        const epochsInput = document.getElementById('epochs');
        const epochs = parseInt(epochsInput.value) || 10;

        this.log(`Starting training process with ${epochs} epochs...`);

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
                const manifestResponse = await fetch('training_data/manifest.json');
                const files = await manifestResponse.json();

                for (const file of files) {
                    this.log(`Loading ${file}...`);
                    const response = await fetch(`training_data/${file}`);
                    const rawData = await response.json();
                    this.log(`Loaded tournament: ${rawData.name}`);

                    // Store raw data or process immediately
                    this.trainingData.push(rawData);
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

        this.trainingData.forEach(rawData => {
            rawData.decks.forEach(deck => {
                const deckIndices = [];
                deck.cards.forEach(cardEntry => {
                    const key = this.getCardKey(cardEntry.name, cardEntry.version);
                    if (this.cardMap.has(key)) {
                        const index = this.cardMap.get(key);
                        for (let i = 0; i < cardEntry.amount; i++) {
                            deckIndices.push(index);
                        }
                    }
                });

                if (deckIndices.length > 0) {
                    // Create a few shuffled versions
                    for (let k = 0; k < 5; k++) {
                        const shuffledIndices = [...deckIndices].sort(() => Math.random() - 0.5);

                        const seqIndices = [];
                        const seqFeatures = [];

                        // Initialize deck stats for this sequence
                        let currentStats = this.getInitialDeckStats();

                        shuffledIndices.forEach(index => {
                            const card = this.indexMap.get(index);

                            // Extract features with CURRENT stats (before adding this card? or after? 
                            // Usually we want features of the card + context of what's already in deck)
                            // Let's use stats BEFORE adding this card to represent "context when this card was chosen"
                            // But wait, if we input x_t, we want to predict x_{t+1}.
                            // The features should describe x_t and the state of the deck including x_t?
                            // If the model sees "Card X", it should know "Card X is the 10th card, 5th inkable".
                            // So we update stats, THEN extract features? 
                            // Or extract features of X, and stats of deck *including* X?
                            // Yes, let's include X in the stats.

                            this.updateDeckStats(currentStats, card);
                            const features = this.extractCardFeatures(card, currentStats);

                            seqIndices.push(index);
                            seqFeatures.push(features);
                        });

                        sequences.push(seqIndices);
                        featureSequences.push(seqFeatures);
                    }
                }
            });
        });
        this.log(`Generated ${sequences.length} sequences from all loaded decks.`);

        // 4. Train Model
        if (!this.model.model) {
            this.log('Initializing new model...');
            // We need to know feature dimension
            const featureDim = featureSequences[0][0].length;
            this.model.initialize(this.cardMap.size, featureDim);
        } else {
            this.log('Continuing training on existing model...');
        }

        this.log('Training model...');
        await this.model.train(sequences, featureSequences, epochs, (epoch, logs) => {
            this.log(`Epoch ${epoch + 1}/${epochs}: loss = ${logs.loss.toFixed(4)}`);
        });

        this.log('Training complete!');
        await this.saveModel();
        document.getElementById('save-model').disabled = false;
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

    extractCardFeatures(card, stats) {
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
            // Check if keyword is in card.keywords array
            // Note: Some keywords might be "Resist +1", we need to check if the word exists.
            // Card.js parses these into boolean flags like hasBodyguard.
            // Let's use those if available, or check keywords array.
            // The Card object from CardApi might not have the `hasX` properties initialized if it's just raw JSON?
            // Wait, CardApi returns `new Card(data)`. So it should have them.
            // Let's check `Card.js`. `initialize()` sets `this.hasBodyguard` etc.
            // So we can use those.
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

        // --- Dynamic Features (Deck Composition) ---
        // Normalize counts by total cards (or 60?)
        // Using totalCards so far allows the model to understand "early game" vs "late game" composition?
        // Or just fraction.
        const total = Math.max(1, stats.totalCards);

        // 12. Inkable Fraction
        features.push(stats.inkableCount / total);

        // 13. Cost Curve (Fractions) - 10 costs
        stats.costCounts.forEach(count => {
            features.push(count / total);
        });

        // 14. Type Distribution (Fractions)
        Object.values(stats.typeCounts).forEach(count => {
            features.push(count / total);
        });

        // 15. Ink Color Distribution (Fractions)
        const inks = ['Amber', 'Amethyst', 'Emerald', 'Ruby', 'Sapphire', 'Steel'];
        inks.forEach(ink => {
            features.push((stats.inkCounts[ink] || 0) / total);
        });

        // 16. Inkable Cost Curve (Fractions) - 10 costs
        stats.inkableCostCounts.forEach(count => {
            features.push(count / total);
        });

        return features;
    }

    async saveModel() {
        this.log('Saving model to local storage...');
        await this.model.saveModel('localstorage://deck-generator-model');
        this.log('Model saved.');
    }

    async loadModel() {
        this.log('Loading model from local storage...');
        try {
            // We need to ensure cards are loaded to have the correct vocab size/mappings
            // In a real app we'd save the mappings too.
            // For now, we assume the user loads the page, fetches cards (which happens on startTraining usually), then loads model.
            // But loadModel might be clicked first.
            // Let's ensure cards are fetched.
            if (this.cards.length === 0) {
                this.log('Fetching cards for mapping...');
                this.cards = await this.cardApi.getCards();
                this.cards.forEach((card, index) => {
                    const key = this.getCardKey(card.name, card.version);
                    if (!this.cardMap.has(key)) {
                        const id = this.cardMap.size;
                        this.cardMap.set(key, id);
                        this.indexMap.set(id, card);
                    }
                });
            }

            await this.model.loadModel('localstorage://deck-generator-model');
            this.log('Model loaded.');
            document.getElementById('save-model').disabled = false;
            document.getElementById('predict-btn').disabled = false;
        } catch (e) {
            this.log(`Error loading model: ${e.message}`);
        }
    }

    getCardKey(name, version) {
        // Normalize key
        return `${name}|${version || ''}`.toLowerCase();
    }

    async predict(cardNames, legalOnly = true) {
        // Convert names to indices
        const indices = [];
        const features = [];

        // We need to reconstruct the deck stats as we go to generate features for the sequence
        let currentStats = this.getInitialDeckStats();

        cardNames.forEach(name => {
            let foundId = null;

            // 1. Try exact match with "Name - Version" format
            if (name.includes(' - ')) {
                const parts = name.split(' - ');
                const cardName = parts[0].trim();
                const cardVersion = parts.slice(1).join(' - ').trim(); // Handle multiple dashes if any
                const key = this.getCardKey(cardName, cardVersion);

                if (this.cardMap.has(key)) {
                    foundId = this.cardMap.get(key);
                }
            }

            // 2. Fallback: fuzzy search
            if (foundId === null) {
                const cleanName = name.trim().toLowerCase();
                for (const [key, id] of this.cardMap.entries()) {
                    // Check if key starts with the clean name (e.g. "elsa" matches "elsa|snow queen")
                    // Or if the key matches the clean name exactly (rare given the | separator)
                    if (key.startsWith(cleanName)) {
                        foundId = id;
                        break; // Take first match
                    }
                }
            }

            if (foundId !== null) {
                indices.push(foundId);

                const card = this.indexMap.get(foundId);
                // Update stats and extract features
                this.updateDeckStats(currentStats, card);
                const cardFeatures = this.extractCardFeatures(card, currentStats);
                features.push(cardFeatures);
            }
        });

        if (indices.length === 0) {
            return "No matching cards found in input.";
        }

        // Count current card amounts and identify ink colors
        const cardCounts = new Map();
        const currentInks = new Set();

        indices.forEach(id => {
            cardCounts.set(id, (cardCounts.get(id) || 0) + 1);
            const card = this.indexMap.get(id);
            if (card && card.ink) {
                currentInks.add(card.ink);
            }
        });

        const probabilities = await this.model.predict(indices, features);

        // Create array of [index, probability] and sort by probability desc
        const sortedPredictions = Array.from(probabilities)
            .map((prob, index) => ({ index, prob }))
            .sort((a, b) => b.prob - a.prob);

        // Find first valid card
        for (const { index } of sortedPredictions) {
            const card = this.indexMap.get(index);
            if (!card) continue; // Invalid index

            // 0. Check Legality
            if (legalOnly && card.legality !== 'legal') {
                continue;
            }

            // 1. Check Card Amount Limit
            const currentAmount = cardCounts.get(index) || 0;
            const maxCopies = card.maxAmount || 4;
            if (currentAmount >= maxCopies) {
                continue;
            }

            // 2. Check Ink Color Limit
            // If we already have 2 or more inks, the new card MUST match one of them.
            // If we have < 2 inks, any ink is allowed (it will either match or be the 2nd color).
            if (currentInks.size >= 2) {
                if (!currentInks.has(card.ink)) {
                    continue;
                }
            }

            return card;
        }

        return null;
    }

    getCardByName(name) {
        let foundId = null;

        // 1. Try exact match with "Name - Version" format
        if (name.includes(' - ')) {
            const parts = name.split(' - ');
            const cardName = parts[0].trim();
            const cardVersion = parts.slice(1).join(' - ').trim();
            const key = this.getCardKey(cardName, cardVersion);

            if (this.cardMap.has(key)) {
                foundId = this.cardMap.get(key);
            }
        }

        // 2. Fallback: fuzzy search
        if (foundId === null) {
            const cleanName = name.trim().toLowerCase();
            for (const [key, id] of this.cardMap.entries()) {
                if (key.startsWith(cleanName)) {
                    foundId = id;
                    break;
                }
            }
        }

        if (foundId !== null) {
            return this.indexMap.get(foundId);
        }
        return null;
    }
}
