const fs = require('fs');
const path = require('path');

/**
 * TextEmbedder - Builds and manages text vocabulary for card embeddings
 * Extracts tokens from card names, keywords, inks, classifications, and text
 */
module.exports = class TextEmbedder {
    constructor() {
        this.tokenToIndex = { '<PAD>': 0, '<UNK>': 1 }; // Reserve 0 for padding, 1 for unknown
        this.indexToToken = { 0: '<PAD>', 1: '<UNK>' };
        this.vocabularySize = 2;
        this.maxTextTokens = 20; // Max tokens per card
        this.allCardNames = []; // Store all card names for text parsing
    }

    /**
     * Build vocabulary from all cards
     * @param {Array} cards - Array of Card objects
     */
    buildVocabulary(cards) {
        const tokenSet = new Set();

        // First pass: collect all card names for later text parsing
        this.allCardNames = cards.map(card => card.name.toLowerCase());

        // Second pass: extract all tokens
        cards.forEach(card => {
            // 1. Card name as single token (multi-word)
            const cardName = card.name.toLowerCase().trim();
            if (cardName) {
                tokenSet.add(cardName);
            }

            // 2. Keywords (individual tokens)
            if (card.keywords && Array.isArray(card.keywords)) {
                card.keywords.forEach(kw => {
                    const token = kw.toLowerCase().trim();
                    if (token) tokenSet.add(token);
                });
            }

            // 3. Ink colors (individual tokens)
            if (card.ink) {
                tokenSet.add(card.ink.toLowerCase());
            }
            if (card.inks && Array.isArray(card.inks)) {
                card.inks.forEach(ink => {
                    if (ink) tokenSet.add(ink.toLowerCase());
                });
            }

            // 4. Classifications (individual tokens)
            if (card.classifications && Array.isArray(card.classifications)) {
                card.classifications.forEach(cls => {
                    const token = cls.toLowerCase().trim();
                    if (token) tokenSet.add(token);
                });
            }

            // 5. Parse sanitized text for card name references and other tokens
            if (card.sanitizedText) {
                const textTokens = this.extractTextTokens(card.sanitizedText, this.allCardNames);
                textTokens.forEach(token => {
                    if (token) tokenSet.add(token);
                });
            }
        });

        // Build token-to-index mapping
        let index = 2; // Start after <PAD> and <UNK>
        Array.from(tokenSet).sort().forEach(token => {
            this.tokenToIndex[token] = index;
            this.indexToToken[index] = token;
            index++;
        });

        this.vocabularySize = index;
        console.log(`Built vocabulary with ${this.vocabularySize} tokens`);
    }

    /**
     * Extract tokens from card text, identifying card names as single tokens
     * @param {string} text - Card text to parse
     * @param {Array} cardNames - All card names in the game
     * @returns {Array} Array of tokens
     */
    extractTextTokens(text, cardNames) {
        const tokens = [];
        let remainingText = text.toLowerCase();

        // First, find and extract card name references
        cardNames.forEach(cardName => {
            if (remainingText.includes(cardName)) {
                tokens.push(cardName);
                // Replace found card names with placeholder to avoid duplicate tokenization
                remainingText = remainingText.replace(new RegExp(cardName, 'g'), ' ');
            }
        });

        // Then tokenize remaining text (individual words)
        const words = remainingText
            .split(/\s+/)
            .map(w => w.trim())
            .filter(w => w.length > 2); // Filter out very short words

        tokens.push(...words);

        return tokens;
    }

    /**
     * Convert card properties to text token indices
     * @param {Object} card - Card object
     * @returns {Array} Array of token indices (padded/truncated to maxTextTokens)
     */
    cardToTextIndices(card) {
        const tokens = [];

        // 1. Card name
        const cardName = card.name.toLowerCase().trim();
        if (cardName && this.tokenToIndex[cardName] !== undefined) {
            tokens.push(this.tokenToIndex[cardName]);
        }

        // 2. Keywords
        if (card.keywords && Array.isArray(card.keywords)) {
            card.keywords.forEach(kw => {
                const token = kw.toLowerCase().trim();
                const idx = this.tokenToIndex[token] || this.tokenToIndex['<UNK>'];
                tokens.push(idx);
            });
        }

        // 3. Ink colors
        if (card.ink) {
            const token = card.ink.toLowerCase();
            const idx = this.tokenToIndex[token] || this.tokenToIndex['<UNK>'];
            tokens.push(idx);
        }

        // 4. Classifications
        if (card.classifications && Array.isArray(card.classifications)) {
            card.classifications.forEach(cls => {
                const token = cls.toLowerCase().trim();
                const idx = this.tokenToIndex[token] || this.tokenToIndex['<UNK>'];
                tokens.push(idx);
            });
        }

        // 5. Text tokens (limited to avoid too many)
        if (card.sanitizedText) {
            const textTokens = this.extractTextTokens(card.sanitizedText, this.allCardNames);
            textTokens.slice(0, 10).forEach(token => { // Limit text tokens
                const idx = this.tokenToIndex[token] || this.tokenToIndex['<UNK>'];
                tokens.push(idx);
            });
        }

        // Pad or truncate to maxTextTokens
        return this.padOrTruncate(tokens, this.maxTextTokens);
    }

    /**
     * Pad or truncate array to specified length
     * @param {Array} arr - Input array
     * @param {number} length - Target length
     * @returns {Array} Padded/truncated array
     */
    padOrTruncate(arr, length) {
        if (arr.length >= length) {
            return arr.slice(0, length);
        }
        const padded = [...arr];
        while (padded.length < length) {
            padded.push(0); // Pad with <PAD> token
        }
        return padded;
    }

    /**
     * Save vocabulary to JSON file
     * @param {string} filePath - Path to save vocabulary
     */
    save(filePath) {
        const data = {
            tokenToIndex: this.tokenToIndex,
            indexToToken: this.indexToToken,
            vocabularySize: this.vocabularySize,
            maxTextTokens: this.maxTextTokens,
            allCardNames: this.allCardNames
        };
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        console.log(`Vocabulary saved to ${filePath}`);
    }

    /**
     * Load vocabulary from JSON file
     * @param {string} filePath - Path to load vocabulary from
     */
    load(filePath) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        this.tokenToIndex = data.tokenToIndex;
        this.indexToToken = data.indexToToken;
        this.vocabularySize = data.vocabularySize;
        this.maxTextTokens = data.maxTextTokens;
        this.allCardNames = data.allCardNames || [];
        console.log(`Vocabulary loaded from ${filePath} (${this.vocabularySize} tokens)`);
    }
}
