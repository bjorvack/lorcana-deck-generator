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
                        const shuffled = [...deckIndices].sort(() => Math.random() - 0.5);
                        sequences.push(shuffled);
                    }
                }
            });
        });
        this.log(`Generated ${sequences.length} sequences from all loaded decks.`);

        // 4. Train Model
        if (!this.model.model) {
            this.log('Initializing new model...');
            this.model.initialize(this.cardMap.size);
        } else {
            this.log('Continuing training on existing model...');
        }

        this.log('Training model...');
        await this.model.train(sequences, epochs, (epoch, logs) => {
            this.log(`Epoch ${epoch + 1}/${epochs}: loss = ${logs.loss.toFixed(4)}`);
        });

        this.log('Training complete!');
        await this.saveModel();
        document.getElementById('save-model').disabled = false;
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

    async predict(cardNames) {
        // Convert names to indices
        const indices = [];
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

        const probabilities = await this.model.predict(indices);

        // Create array of [index, probability] and sort by probability desc
        const sortedPredictions = Array.from(probabilities)
            .map((prob, index) => ({ index, prob }))
            .sort((a, b) => b.prob - a.prob);

        // Find first valid card
        for (const { index } of sortedPredictions) {
            const card = this.indexMap.get(index);
            if (!card) continue; // Invalid index

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
