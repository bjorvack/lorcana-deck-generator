/**
 * TextEmbedder - Builds and manages text vocabulary for card embeddings
 * Browser version - handles text tokenization for prediction
 */
export default class TextEmbedder {
  constructor () {
    this.tokenToIndex = { '<PAD>': 0, '<UNK>': 1 } // Reserve 0 for padding, 1 for unknown
    this.indexToToken = { 0: '<PAD>', 1: '<UNK>' }
    this.vocabularySize = 2

    // Define max lengths for each input type
    this.maxNameTokens = 5
    this.maxKeywordsTokens = 10
    this.maxInkTokens = 2
    this.maxClassTokens = 5
    this.maxTypeTokens = 3
    this.maxBodyTokens = 30 // Card text

    this.allCardNames = [] // Store all card names for text parsing
  }

  /**
     * Load vocabulary from JSON object
     * @param {Object} data - Vocabulary data loaded from JSON
     */
  load (data) {
    this.tokenToIndex = data.tokenToIndex
    this.indexToToken = data.indexToToken
    this.vocabularySize = data.vocabularySize

    // Load max lengths if available, otherwise defaults
    this.maxNameTokens = data.maxNameTokens || 5
    this.maxKeywordsTokens = data.maxKeywordsTokens || 10
    this.maxInkTokens = data.maxInkTokens || 2
    this.maxClassTokens = data.maxClassTokens || 5
    this.maxTypeTokens = data.maxTypeTokens || 3
    this.maxBodyTokens = data.maxBodyTokens || 30

    this.allCardNames = data.allCardNames || []
    console.log(`Vocabulary loaded (${this.vocabularySize} tokens)`)
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
      if (this.tokenToIndex[cardName] !== undefined) {
        nameTokens.push(this.tokenToIndex[cardName])
      } else {
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

    // Note: In browser we might need to construct sanitizedText if it's not on the card object
    let textToProcess = card.sanitizedText
    if (!textToProcess && card.text) {
      // Basic sanitization if sanitizedText is missing
      textToProcess = card.text.toLowerCase()
        .replace(/\([^)]+\)/g, '') // Remove parens content
        .replace(/\(|\)/g, '') // Remove parens
        .trim()
    }

    if (textToProcess) {
      const textTokens = this.extractTextTokens(textToProcess, this.allCardNames)
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
}
