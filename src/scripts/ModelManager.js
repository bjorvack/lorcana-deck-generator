import CardApi from './CardApi';
import DeckModel from './DeckModel';
import TextEmbedder from './TextEmbedder';

export default class ModelManager {
    constructor() {
        this.cardApi = new CardApi();
        this.model = new DeckModel();
        this.textEmbedder = new TextEmbedder();
        this.cards = [];
        this.cardMap = new Map(); // Name -> Index
        this.indexMap = new Map(); // Index -> Card
    }

    getCardKey(name, version) {
        return version ? `${name} - ${version}` : name;
    }

    async loadCards() {
        if (this.cards.length === 0) {
            this.cards = await this.cardApi.getCards();
            // Build card maps
            this.cards.forEach((card) => {
                const key = this.getCardKey(card.name, card.version);
                if (!this.cardMap.has(key)) {
                    const id = this.cardMap.size;
                    this.cardMap.set(key, id);
                    this.indexMap.set(id, card);
                }
            });
        }
        return this.cards;
    }

    async loadModel(modelPath) {
        await this.loadCards();

        // Load vocabulary
        try {
            const vocabResponse = await fetch('training_data/vocabulary.json');
            if (vocabResponse.ok) {
                const vocabData = await vocabResponse.json();
                this.textEmbedder.load(vocabData);
            } else {
                console.error('Failed to load vocabulary.json');
            }
        } catch (e) {
            console.error('Error loading vocabulary:', e);
        }

        await this.model.loadModel(modelPath);
    }

    async predict(cardNames, legalOnly = true, allowedInks = []) {
        // Convert names to indices
        const indices = [];
        const features = [];
        const textIndices = []; // NEW

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
                    if (key.toLowerCase().startsWith(cleanName)) {
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

                // Count copies of this card before extracting features
                const copiesSoFar = indices.filter(id => id === foundId).length - 1;
                const cardFeatures = this.extractCardFeatures(card, currentStats, copiesSoFar);
                const cardTextIndices = this.textEmbedder.cardToTextIndices(card); // NEW

                features.push(cardFeatures);
                textIndices.push(cardTextIndices); // NEW
            }
        });

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

        const probabilities = await this.model.predict(indices, features, textIndices);

        // Calculate adaptive temperature based on deck size
        const temperature = this.getAdaptiveTemperature(indices.length);

        // Sample with temperature for exploration/exploitation balance
        const sampledIndex = this.sampleWithTemperature(probabilities, temperature);

        // Create array of candidate indices, starting with sampled one, then sorted by probability
        const sortedPredictions = Array.from(probabilities)
            .map((prob, index) => ({ index, prob }))
            .sort((a, b) => b.prob - a.prob);

        // Put sampled card first, then add rest
        const candidateIndices = [
            sampledIndex,
            ...sortedPredictions.map(p => p.index).filter(i => i !== sampledIndex)
        ];

        // Find first valid card from candidates
        for (const index of candidateIndices) {
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
            // If allowedInks are provided, strict check against them
            if (allowedInks.length > 0) {
                const cardInks = card.inks || (card.ink ? [card.ink] : []);
                const isAllowed = cardInks.every(ink => allowedInks.includes(ink));
                if (!isAllowed) {
                    continue;
                }
            }

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

    /**
     * Calculate adaptive temperature based on deck size
     * High temperature (1.5) early for exploration
     * Low temperature (0.7) late for focused completion
     */
    getAdaptiveTemperature(deckSize) {
        if (deckSize <= 20) {
            return 1.5; // High exploration for early deck building
        } else if (deckSize <= 40) {
            return 1.0; // Balanced
        } else {
            return 0.7; // Low exploration, focus on completing deck
        }
    }

    /**
     * Sample from probability distribution using temperature scaling
     * Higher temperature = more exploration (flatter distribution)
     * Lower temperature = more exploitation (peaked distribution)
     */
    sampleWithTemperature(probabilities, temperature = 1.0) {
        // Apply temperature scaling: p_i^(1/T)
        const scaledProbs = Array.from(probabilities).map(p =>
            Math.pow(Math.max(p, 1e-10), 1 / temperature)
        );

        // Normalize to sum to 1
        const sum = scaledProbs.reduce((a, b) => a + b, 0);
        const normalized = scaledProbs.map(p => p / sum);

        // Sample from the distribution
        const rand = Math.random();
        let cumSum = 0;
        for (let i = 0; i < normalized.length; i++) {
            cumSum += normalized[i];
            if (rand < cumSum) {
                return i;
            }
        }

        // Fallback to last index (shouldn't happen)
        return normalized.length - 1;
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
        let cIdx = Math.max(0, Math.min(card.cost - 1, 9));
        if (card.cost === 0) cIdx = 0;
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
                if (key.toLowerCase().startsWith(cleanName)) {
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
