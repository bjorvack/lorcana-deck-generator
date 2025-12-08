const fs = require('fs')
/**
 * TextEmbedder - Builds and manages text vocabulary for card embeddings
 * Extracts tokens from card names, keywords, inks, classifications, and text
 */
module.exports = class TextEmbedder {
  constructor () {
    this.tokenToIndex = { '<PAD>': 0, '<UNK>': 1 } // Reserve 0 for padding, 1 for unknown
    this.indexToToken = { 0: '<PAD>', 1: '<UNK>' }
    this.vocabularySize = 2

    // Define max lengths for each input type
    this.maxNameTokens = 5
    this.maxKeywordsTokens = 10
    this.maxInkTokens = 2 // Usually 1, maybe 2 for multi-ink? (Currently cards are single ink, but future proof)
    this.maxClassTokens = 5
    this.maxTypeTokens = 3
    this.maxBodyTokens = 30 // Card text

    this.allCardNames = [] // Store all card names for text parsing
  }

  /**
     * Build vocabulary from all cards
     * @param {Array} cards - Array of Card objects
     */
  buildVocabulary (cards) {
    const tokenSet = new Set()

    // First pass: collect all card names for later text parsing
    // Normalize names to handle apostrophe differences etc.
    this.allCardNames = cards.map(card => this.cleanText(card.name)).filter(name => name.length > 0)

    // Second pass: extract all tokens
    cards.forEach(card => {
      // 1. Card name
      const cardName = this.cleanText(card.name)
      if (cardName) {
        tokenSet.add(cardName)
      }

      // 2. Keywords
      if (card.keywords && Array.isArray(card.keywords)) {
        card.keywords.forEach(kw => {
          const token = this.cleanText(kw)
          if (token) tokenSet.add(token)
        })
      }

      // 3. Ink
      if (card.ink) {
        tokenSet.add(this.cleanText(card.ink))
      }
      if (card.inks && Array.isArray(card.inks)) {
        card.inks.forEach(ink => {
          if (ink) tokenSet.add(this.cleanText(ink))
        })
      }

      // 4. Classifications
      if (card.classifications && Array.isArray(card.classifications)) {
        card.classifications.forEach(cls => {
          const token = this.cleanText(cls)
          if (token) tokenSet.add(token)
        })
      }

      // 5. Types
      if (card.types && Array.isArray(card.types)) {
        card.types.forEach(type => {
          const token = this.cleanText(type)
          if (token) tokenSet.add(token)
        })
      } else if (card.type && Array.isArray(card.type)) {
        card.type.forEach(type => {
          const token = this.cleanText(type)
          if (token) tokenSet.add(token)
        })
      }

      // 6. Body Text
      if (card.sanitizedText) {
        const textTokens = this.extractTextTokens(card.sanitizedText, this.allCardNames)
        textTokens.forEach(token => {
          if (token) tokenSet.add(token)
        })
      }
    })

    // Build token-to-index mapping
    let index = 2 // Start after <PAD> and <UNK>
    Array.from(tokenSet).sort().forEach(token => {
      this.tokenToIndex[token] = index
      this.indexToToken[index] = token
      index++
    })

    this.vocabularySize = index
    console.log(`Built vocabulary with ${this.vocabularySize} tokens`)
  }

  /**
     * Clean text by removing unwanted symbols and expanding abbreviations
     * @param {string} text - Input text
     * @returns {string} Cleaned text
     */
  cleanText (text) {
    if (!text) return ''
    let cleaned = text.toLowerCase()

    // Expand abbreviations
    cleaned = cleaned.replace(/\{e\}/g, ' exert ')

    // Remove all characters except alphanumeric, spaces, +, {, }
    // This removes ., ,, ", ', -, etc.
    cleaned = cleaned.replace(/[^a-z0-9\s+{}]/g, '')

    return cleaned.trim()
  }

  /**
     * Extract tokens from card text, identifying card names as single tokens
     * @param {string} text - Card text to parse
     * @param {Array} cardNames - All card names in the game
     * @returns {Array} Array of tokens
     */
  extractTextTokens (text, cardNames) {
    const tokens = []
    // Clean text first to ensure it matches normalized card names
    let remainingText = this.cleanText(text)

    // First, find and extract card name references
    cardNames.forEach(cardName => {
      if (remainingText.includes(cardName)) {
        tokens.push(cardName)
        // Replace found card names with placeholder to avoid duplicate tokenization
        remainingText = remainingText.replace(new RegExp(cardName, 'g'), ' ')
      }
    })

    // Then tokenize remaining text (individual words)
    const words = remainingText
      .split(/\s+/)
      .map(w => w.trim())
      .filter(w => w.length > 2 || w === '+' || w === '{' || w === '}') // Keep special symbols even if short

    tokens.push(...words)

    return tokens
  }

  /**
     * Convert card properties to text token indices
     * @param {Object} card - Card object
     * @returns {Object} Object containing token arrays for name, keywords, ink, classifications, types, text
     */
  cardToTextIndices (card) {
    // 1. Name Tokens
    const nameTokens = []
    const cardName = this.cleanText(card.name)
    if (cardName) {
      // Split name into words if needed, but currently we treat full name as one token if in vocab
      // But if we want to handle "Simba" and "Returned King" separately?
      // For now, let's stick to the existing logic: check if full name is a token
      if (this.tokenToIndex[cardName] !== undefined) {
        nameTokens.push(this.tokenToIndex[cardName])
      } else {
        // Fallback: tokenize name? No, let's stick to <UNK> if not found
        nameTokens.push(this.tokenToIndex['<UNK>'])
      }
    }

    // 2. Keywords Tokens
    const keywordsTokens = []
    if (card.keywords && Array.isArray(card.keywords)) {
      card.keywords.forEach(kw => {
        const token = this.cleanText(kw)
        const idx = this.tokenToIndex[token] || this.tokenToIndex['<UNK>']
        keywordsTokens.push(idx)
      })
    }

    // 3. Ink Tokens
    const inkTokens = []
    if (card.ink) {
      const token = this.cleanText(card.ink)
      const idx = this.tokenToIndex[token] || this.tokenToIndex['<UNK>']
      inkTokens.push(idx)
    }

    // 4. Classifications Tokens
    const classTokens = []
    if (card.classifications && Array.isArray(card.classifications)) {
      card.classifications.forEach(cls => {
        const token = this.cleanText(cls)
        const idx = this.tokenToIndex[token] || this.tokenToIndex['<UNK>']
        classTokens.push(idx)
      })
    }

    // 5. Types Tokens
    const typeTokens = []
    if (card.types && Array.isArray(card.types)) {
      card.types.forEach(type => {
        const token = this.cleanText(type)
        const idx = this.tokenToIndex[token] || this.tokenToIndex['<UNK>']
        typeTokens.push(idx)
      })
    } else if (card.type && Array.isArray(card.type)) {
      card.type.forEach(type => {
        const token = this.cleanText(type)
        const idx = this.tokenToIndex[token] || this.tokenToIndex['<UNK>']
        typeTokens.push(idx)
      })
    }

    // 6. Body Text Tokens
    const bodyTokens = []
    if (card.sanitizedText) {
      const textTokens = this.extractTextTokens(card.sanitizedText, this.allCardNames)
      textTokens.forEach(token => {
        const idx = this.tokenToIndex[token] || this.tokenToIndex['<UNK>']
        bodyTokens.push(idx)
      })
    }

    // Pad or truncate each
    return {
      name: this.padOrTruncate(nameTokens, this.maxNameTokens),
      keywords: this.padOrTruncate(keywordsTokens, this.maxKeywordsTokens),
      ink: this.padOrTruncate(inkTokens, this.maxInkTokens),
      classifications: this.padOrTruncate(classTokens, this.maxClassTokens),
      types: this.padOrTruncate(typeTokens, this.maxTypeTokens),
      text: this.padOrTruncate(bodyTokens, this.maxBodyTokens)
    }
  }

  /**
     * Pad or truncate array to specified length
     * @param {Array} arr - Input array
     * @param {number} length - Target length
     * @returns {Array} Padded/truncated array
     */
  padOrTruncate (arr, length) {
    if (arr.length >= length) {
      return arr.slice(0, length)
    }
    const padded = [...arr]
    while (padded.length < length) {
      padded.push(0) // Pad with <PAD> token
    }
    return padded
  }

  /**
     * Save vocabulary to JSON file
     * @param {string} filePath - Path to save vocabulary
     */
  save (filePath) {
    const data = {
      tokenToIndex: this.tokenToIndex,
      indexToToken: this.indexToToken,
      vocabularySize: this.vocabularySize,
      maxNameTokens: this.maxNameTokens,
      maxKeywordsTokens: this.maxKeywordsTokens,
      maxInkTokens: this.maxInkTokens,
      maxClassTokens: this.maxClassTokens,
      maxTypeTokens: this.maxTypeTokens,
      maxBodyTokens: this.maxBodyTokens,
      allCardNames: this.allCardNames
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
    console.log(`Vocabulary saved to ${filePath}`)
  }

  /**
     * Load vocabulary from JSON file
     * @param {string} filePath - Path to load vocabulary from
     */
  load (filePath) {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    this.tokenToIndex = data.tokenToIndex
    this.indexToToken = data.indexToToken
    this.vocabularySize = data.vocabularySize
    this.maxTextTokens = data.maxTextTokens
    this.allCardNames = data.allCardNames || []
    console.log(`Vocabulary loaded from ${filePath} (${this.vocabularySize} tokens)`)
  }
}
