import CardApi from './CardApi'
import DeckModel from './DeckModel'
import TextEmbedder from './TextEmbedder'
import ValidationModel from './ValidationModel'

export default class ModelManager {
  constructor () {
    this.cardApi = new CardApi()
    this.model = new DeckModel()
    this.textEmbedder = new TextEmbedder()
    this.validationModel = new ValidationModel() // NEW
    this.validationModelLoaded = false // NEW
    this.cards = []
    this.cardMap = new Map() // Name -> Index
    this.indexMap = new Map() // Index -> Card
  }

  getCardKey (name, version) {
    return version ? `${name} - ${version}` : name
  }

  async loadCards () {
    if (this.cards.length === 0) {
      this.cards = await this.cardApi.getCards()
      // Build card maps
      this.cards.forEach((card) => {
        const key = this.getCardKey(card.name, card.version)
        if (!this.cardMap.has(key)) {
          const id = this.cardMap.size
          this.cardMap.set(key, id)
          this.indexMap.set(id, card)
        }
      })
    }
    return this.cards
  }

  async loadModel (modelPath) {
    await this.loadCards()

    // Load vocabulary
    try {
      const vocabResponse = await fetch('training_data/vocabulary.json')
      if (vocabResponse.ok) {
        const vocabData = await vocabResponse.json()
        this.textEmbedder.load(vocabData)
      } else {
        console.error('Failed to load vocabulary.json')
      }
    } catch (e) {
      console.error('Error loading vocabulary:', e)
    }

    await this.model.loadModel(modelPath)
  }

  async predict (cardNames, legalOnly = true, allowedInks = []) {
    // Convert names to indices
    const indices = []

    cardNames.forEach((name) => {
      let foundId = null

      // 1. Try exact match with "Name - Version" format
      if (name.includes(' - ')) {
        const parts = name.split(' - ')
        const cardName = parts[0].trim()
        const cardVersion = parts.slice(1).join(' - ').trim()
        const key = this.getCardKey(cardName, cardVersion)

        if (this.cardMap.has(key)) {
          foundId = this.cardMap.get(key)
        }
      }

      // 2. Fallback: fuzzy search
      if (foundId === null) {
        const cleanName = name.trim().toLowerCase()
        for (const [key, id] of this.cardMap.entries()) {
          if (key.toLowerCase().startsWith(cleanName)) {
            foundId = id
            break // Take first match
          }
        }
      }

      if (foundId !== null) {
        // Add 1 because model uses 1-based indexing (0 is padding)
        // Wait, backend TrainingManager uses indexMap keys (0..N) and adds 1?
        // Let's check TrainingManager.prepareTrainingData:
        // const cardId = this.cardMap.get(key) + 1;
        // So yes, we need to add 1 to the ID for the model.
        indices.push(foundId + 1)
      }
    })

    // Count current card amounts and identify ink colors for filtering
    const cardCounts = new Map()
    const currentInks = new Set()

    indices.forEach((modelId) => {
      const id = modelId - 1 // Convert back to 0-based for map lookup
      cardCounts.set(id, (cardCounts.get(id) || 0) + 1)
      const card = this.indexMap.get(id)
      if (card && card.ink) {
        currentInks.add(card.ink)
      }
    })

    // 3. Predict next card probabilities
    // Input is just the array of indices
    const probabilities = await this.model.predict(indices)

    // 1. (Removed) Repetition Penalty
    // User feedback: Decks need up to 4 copies, so penalizing repetition is counter-productive for constructed decks.
    // const penalizedProbabilities = probabilities; // Pass through without penalty

    // 1. Boost Singletons (NEW)
    // If a card is in the deck exactly once, boost its probability to encourage a 2nd copy (consistency)
    const boostedProbabilities = this.boostSingletons(
      probabilities,
      indices,
      2.5
    )

    // 2. Calculate adaptive temperature based on deck size
    const temperature = this.getAdaptiveTemperature(indices.length)

    // 3. Sample using Top-P (Nucleus) Sampling with Temperature
    // This combines temperature scaling and dynamic truncation of the tail
    const sampledIndex = this.sampleTopP(
      boostedProbabilities,
      temperature,
      0.9
    )

    // Create array of candidate indices, starting with sampled one, then sorted by probability
    const sortedPredictions = Array.from(boostedProbabilities)
      .map((prob, index) => ({ index, prob }))
      .sort((a, b) => b.prob - a.prob)

    // Put sampled card first, then add rest
    const candidateIndices = [
      sampledIndex,
      ...sortedPredictions
        .map((p) => p.index)
        .filter((i) => i !== sampledIndex)
    ]

    // Find first valid card from candidates
    for (const index of candidateIndices) {
      const card = this.indexMap.get(index)
      if (!card) continue // Invalid index

      // 0. Check Legality
      if (legalOnly && card.legality !== 'legal') {
        continue
      }

      // 1. Check Card Amount Limit
      const currentAmount = cardCounts.get(index) || 0
      const maxCopies = card.maxAmount || 4
      if (currentAmount >= maxCopies) {
        continue
      }

      // 2. Check Ink Color Limit
      // If allowedInks are provided, strict check against them
      if (allowedInks.length > 0) {
        const cardInks = card.inks || (card.ink ? [card.ink] : [])
        const isAllowed = cardInks.every((ink) => allowedInks.includes(ink))
        if (!isAllowed) {
          continue
        }
      }

      // If we already have 2 or more inks, the new card MUST match one of them.
      // If we have < 2 inks, any ink is allowed (it will either match or be the 2nd color).
      if (currentInks.size >= 2) {
        if (!currentInks.has(card.ink)) {
          continue
        }
      }

      return card
    }

    return null
  }

  /**
   * Calculate adaptive temperature based on deck size
   * High temperature (2.5) early for exploration
   * Low temperature (0.7) late for focused completion
   */
  getAdaptiveTemperature (deckSize) {
    if (deckSize <= 10) {
      return 2.0 // Slightly lower than before to balance with Top-P
    } else if (deckSize <= 40) {
      return 1.0 // Balanced
    } else {
      return 0.8 // Low exploration, focus on completing deck
    }
  }

  /**
   * Boost probability of cards that are in the deck exactly once.
   * Encourages picking a 2nd copy for consistency.
   */
  boostSingletons (probabilities, historyIndices, boostFactor = 2.0) {
    const boosted = Float32Array.from(probabilities)

    // Count occurrences in history
    const counts = new Map()
    for (const idx of historyIndices) {
      counts.set(idx, (counts.get(idx) || 0) + 1)
    }

    // Apply boost
    for (const [idx, count] of counts) {
      if (count === 1 && idx < boosted.length) {
        boosted[idx] *= boostFactor
      }
    }

    // Renormalize
    let sum = 0
    for (let i = 0; i < boosted.length; i++) sum += boosted[i]
    if (sum > 0) {
      for (let i = 0; i < boosted.length; i++) boosted[i] /= sum
    }

    return boosted
  }

  /**
   * Sample using Top-P (Nucleus) Sampling
   * 1. Apply temperature
   * 2. Sort probabilities
   * 3. Take top P mass
   * 4. Sample from that subset
   */
  sampleTopP (probabilities, temperature = 1.0, topP = 0.9) {
    // 1. Apply temperature scaling
    const scaledProbs = Array.from(probabilities).map((p, i) => ({
      prob: Math.pow(Math.max(p, 1e-10), 1 / temperature),
      index: i
    }))

    // Normalize scaled probs
    const sum = scaledProbs.reduce((a, b) => a + b.prob, 0)
    scaledProbs.forEach((p) => {
      p.prob /= sum
    })

    // 2. Sort by probability descending
    scaledProbs.sort((a, b) => b.prob - a.prob)

    // 3. Cumulative sum and cutoff
    let cumulativeProb = 0
    const candidates = []

    for (const item of scaledProbs) {
      cumulativeProb += item.prob
      candidates.push(item)
      if (cumulativeProb >= topP) {
        break
      }
    }

    // Ensure we have at least one candidate
    if (candidates.length === 0) candidates.push(scaledProbs[0])

    // 4. Sample from candidates
    // Renormalize candidate probabilities
    const candidateSum = candidates.reduce((a, b) => a + b.prob, 0)
    const rand = Math.random() * candidateSum

    let currentSum = 0
    for (const item of candidates) {
      currentSum += item.prob
      if (rand <= currentSum) {
        return item.index
      }
    }

    return candidates[candidates.length - 1].index
  }

  getInitialDeckStats () {
    return {
      totalCards: 0,
      inkableCount: 0,
      costCounts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // Costs 1-10
      inkableCostCounts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // Inkable cards at costs 1-10
      typeCounts: {
        character: 0,
        action: 0,
        item: 0,
        location: 0
      },
      inkCounts: {
        Amber: 0,
        Amethyst: 0,
        Emerald: 0,
        Ruby: 0,
        Sapphire: 0,
        Steel: 0
      }
    }
  }

  updateDeckStats (stats, card) {
    stats.totalCards++
    if (card.inkwell) stats.inkableCount++

    // Map cost to index: costs 1-10 -> indices 0-9, cost 0 or >10 -> capped
    let cIdx = Math.max(0, Math.min(card.cost - 1, 9))
    if (card.cost === 0) cIdx = 0
    stats.costCounts[cIdx]++

    // Track inkable cards per cost
    if (card.inkwell) {
      stats.inkableCostCounts[cIdx]++
    }

    // Track ink color distribution
    if (card.ink) {
      if (!stats.inkCounts[card.ink]) {
        stats.inkCounts[card.ink] = 0
      }
      stats.inkCounts[card.ink]++
    }

    // Track type distribution with safety check
    if (card.type) {
      const t = card.type.toLowerCase()
      if (stats.typeCounts[t] !== undefined) {
        stats.typeCounts[t]++
      }
    }
  }

  extractCardFeatures (card, stats, copiesSoFar = 0) {
    const features = []

    // --- Static Features ---

    // 1. Cost (Normalized 0-10 -> 0-1)
    features.push(Math.min(card.cost, 10) / 10)

    // 2. Inkwell (0 or 1)
    features.push(card.inkwell ? 1 : 0)

    // 3. Lore (Normalized 0-5)
    features.push(Math.min(card.lore || 0, 5) / 5)

    // 4. Strength (Normalized 0-10)
    features.push(Math.min(card.strength || 0, 10) / 10)

    // 5. Willpower (Normalized 0-10)
    features.push(Math.min(card.willpower || 0, 10) / 10)

    // 6. Inks (One-hot)
    const inkColors = [
      'Amber',
      'Amethyst',
      'Emerald',
      'Ruby',
      'Sapphire',
      'Steel'
    ]
    inkColors.forEach((ink) => {
      features.push(card.ink === ink ? 1 : 0)
    })

    // 7. Types (One-hot)
    const types = ['Character', 'Action', 'Item', 'Location']
    const cardType = card.types && card.types.length > 0 ? card.types[0] : ''
    types.forEach((type) => {
      features.push(cardType === type ? 1 : 0)
    })

    // 8. Keyword Booleans (10 features)
    const keywords = [
      'Bodyguard',
      'Reckless',
      'Rush',
      'Ward',
      'Evasive',
      'Resist',
      'Challenger',
      'Singer',
      'Shift',
      'Boost'
    ]
    keywords.forEach((kw) => {
      const propName = `has${kw}`
      if (card[propName] !== undefined) {
        features.push(card[propName] ? 1 : 0)
      } else {
        // Fallback to checking keywords array
        const hasKw =
          card.keywords && card.keywords.some((k) => k.includes(kw))
        features.push(hasKw ? 1 : 0)
      }
    })

    // 9. Keyword Amounts (3 features)
    features.push(Math.min(card.resistAmount || 0, 10) / 10) // Resist +X
    features.push(Math.min(card.challengerAmount || 0, 10) / 10) // Challenger +X
    features.push(Math.min(card.boostAmount || 0, 10) / 10) // Boost +X

    // 10. Move Cost (1 feature)
    features.push(Math.min(card.moveCost || 0, 10) / 10)

    // 11. Classifications (5 features) - Common card classifications
    const commonClassifications = [
      'Hero',
      'Villain',
      'Dreamborn',
      'Storyborn',
      'Floodborn'
    ]
    commonClassifications.forEach((cls) => {
      features.push(
        card.classifications && card.classifications.includes(cls) ? 1 : 0
      )
    })

    // 12. Copies of this card so far (NEW FEATURE)
    features.push(Math.min(copiesSoFar, 4) / 4)

    // --- Dynamic Features (Deck Composition) ---
    const total = Math.max(1, stats.totalCards)

    // 13. Inkable Fraction
    features.push(stats.inkableCount / total)

    // 14. Cost Curve (Fractions) - 10 costs
    stats.costCounts.forEach((count) => {
      features.push(count / total)
    })

    // 15. Type Distribution (Fractions)
    Object.values(stats.typeCounts).forEach((count) => {
      features.push(count / total)
    })

    // 16. Ink Color Distribution (Fractions)
    const inks = ['Amber', 'Amethyst', 'Emerald', 'Ruby', 'Sapphire', 'Steel']
    inks.forEach((ink) => {
      features.push((stats.inkCounts[ink] || 0) / total)
    })

    // 17. Inkable Cost Curve (Fractions) - 10 costs
    stats.inkableCostCounts.forEach((count) => {
      features.push(count / total)
    })

    return features
  }

  getCardByName (name) {
    let foundId = null

    // 1. Try exact match with "Name - Version" format
    if (name.includes(' - ')) {
      const parts = name.split(' - ')
      const cardName = parts[0].trim()
      const cardVersion = parts.slice(1).join(' - ').trim()
      const key = this.getCardKey(cardName, cardVersion)

      if (this.cardMap.has(key)) {
        foundId = this.cardMap.get(key)
      }
    }

    // 2. Fallback: fuzzy search
    if (foundId === null) {
      const cleanName = name.trim().toLowerCase()
      for (const [key, id] of this.cardMap.entries()) {
        if (key.toLowerCase().startsWith(cleanName)) {
          foundId = id
          break
        }
      }
    }

    if (foundId !== null) {
      return this.indexMap.get(foundId)
    }
    return null
  }

  async loadValidationModel (modelPath) {
    try {
      await this.validationModel.loadModel(modelPath)
      this.validationModelLoaded = true
      console.log('Validation model loaded successfully')
    } catch (e) {
      console.error('Failed to load validation model:', e)
      this.validationModelLoaded = false
    }
  }

  /**
   * Compute a simple embedding for a card based on its text properties
   * Returns a 32-dimensional vector
   */
  computeCardEmbedding (card) {
    const embeddingDim = 32
    const embedding = new Array(embeddingDim).fill(0)

    // Combine all text properties
    const textParts = [
      card.name || '',
      card.keywords ? card.keywords.join(' ') : '',
      card.classifications ? card.classifications.join(' ') : '',
      card.types ? card.types.join(' ') : '',
      card.ink || '',
      card.text || ''
    ]
    const combinedText = textParts.join(' ').toLowerCase()

    // Simple character-based hashing into embedding dimensions
    for (let i = 0; i < combinedText.length; i++) {
      const charCode = combinedText.charCodeAt(i)
      const bucket = charCode % embeddingDim
      embedding[bucket] += 1.0
    }

    // Normalize
    const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0))
    if (norm > 0) {
      for (let i = 0; i < embeddingDim; i++) {
        embedding[i] /= norm
      }
    }

    return embedding
  }

  /**
   * Extract deck-level features for validation
   * Returns 134 features: 38 numeric + 96 embedding stats (mean/max/variance)
   */
  extractDeckFeatures (deck) {
    const features = []

    // Convert deck of cards to indices
    const deckIndices = []
    deck.forEach((card) => {
      const key = this.getCardKey(card.name, card.version)
      if (this.cardMap.has(key)) {
        deckIndices.push(this.cardMap.get(key))
      }
    })

    // Count cards by copy amount
    const copyDistribution = [0, 0, 0, 0, 0]
    const cardCounts = new Map()
    for (const idx of deckIndices) {
      cardCounts.set(idx, (cardCounts.get(idx) || 0) + 1)
    }

    // CRITICAL FIX: Add unique card count as first feature
    // Tournament decks typically have 15-20 unique cards
    const uniqueCardCount = cardCounts.size
    features.push(uniqueCardCount / 20) // Normalize by typical deck diversity

    for (const count of cardCounts.values()) {
      if (count === 1) copyDistribution[0]++
      else if (count === 2) copyDistribution[1]++
      else if (count === 3) copyDistribution[2]++
      else if (count === 4) copyDistribution[3]++
      else copyDistribution[4]++
    }
    const totalUniqueCards = [...cardCounts.keys()].length
    copyDistribution.forEach((count, i) =>
      features.push(count / Math.max(1, totalUniqueCards))
    )

    // Mana curve distribution
    const costCounts = Array(10).fill(0)
    let inkableCount = 0
    const totalCards = deckIndices.length
    const typeCounts = { character: 0, action: 0, item: 0, location: 0 }
    const inkCounts = {
      Amber: 0,
      Amethyst: 0,
      Emerald: 0,
      Ruby: 0,
      Sapphire: 0,
      Steel: 0
    }
    const keywordCounts = {
      Ward: 0,
      Evasive: 0,
      Bodyguard: 0,
      Resist: 0,
      Singer: 0,
      Shift: 0,
      Reckless: 0,
      Challenger: 0,
      Rush: 0
    }
    const classificationCounts = new Map()

    for (const idx of deckIndices) {
      const card = this.indexMap.get(idx)
      if (!card) continue

      const costIdx = Math.min(card.cost - 1, 9)
      costCounts[costIdx]++

      if (card.inkwell) inkableCount++

      if (card.types && card.types.length > 0) {
        const t = card.types[0].toLowerCase()
        if (typeCounts[t] !== undefined) typeCounts[t]++
      }

      if (card.ink && inkCounts[card.ink] !== undefined) {
        inkCounts[card.ink]++
      }

      for (const keyword of Object.keys(keywordCounts)) {
        const propName = `has${keyword}`
        if (
          card[propName] ||
          (card.keywords && card.keywords.some((k) => k.includes(keyword)))
        ) {
          keywordCounts[keyword]++
        }
      }

      if (card.classifications) {
        for (const cls of card.classifications) {
          classificationCounts.set(
            cls,
            (classificationCounts.get(cls) || 0) + 1
          )
        }
      }
    }

    // Add features
    costCounts.forEach((count) => features.push(count / totalCards))
    Object.values(typeCounts).forEach((count) =>
      features.push(count / totalCards)
    )
    Object.values(inkCounts).forEach((count) =>
      features.push(count / totalCards)
    )
    features.push(inkableCount / totalCards)
    Object.values(keywordCounts).forEach((count) =>
      features.push(count / totalCards)
    )
    features.push(classificationCounts.size / 10)
    const avgClassificationSharing =
      classificationCounts.size > 0
        ? Array.from(classificationCounts.values()).reduce((a, b) => a + b, 0) /
          classificationCounts.size /
          totalCards
        : 0
    features.push(avgClassificationSharing)

    // Add embedding aggregation features
    const embeddings = []
    for (const idx of deckIndices) {
      const card = this.indexMap.get(idx)
      if (card) {
        embeddings.push(this.computeCardEmbedding(card))
      }
    }

    if (embeddings.length === 0) {
      // No embeddings, add zeros
      const zeros = new Array(32 * 3).fill(0)
      features.push(...zeros)
      return features
    }

    const embeddingDim = 32
    const meanEmbedding = new Array(embeddingDim).fill(0)
    const maxEmbedding = new Array(embeddingDim).fill(-Infinity)

    // Compute mean and max
    for (const emb of embeddings) {
      for (let i = 0; i < embeddingDim; i++) {
        meanEmbedding[i] += emb[i]
        maxEmbedding[i] = Math.max(maxEmbedding[i], emb[i])
      }
    }
    for (let i = 0; i < embeddingDim; i++) {
      meanEmbedding[i] /= embeddings.length
    }

    // Compute variance
    const varianceEmbedding = new Array(embeddingDim).fill(0)
    for (const emb of embeddings) {
      for (let i = 0; i < embeddingDim; i++) {
        const diff = emb[i] - meanEmbedding[i]
        varianceEmbedding[i] += diff * diff
      }
    }
    for (let i = 0; i < embeddingDim; i++) {
      varianceEmbedding[i] /= embeddings.length
    }

    // Add mean, max, variance embeddings (32 + 32 + 32 = 96 features)
    features.push(...meanEmbedding)
    features.push(...maxEmbedding)
    features.push(...varianceEmbedding)

    return features // Now returns 134 features total
  }

  /**
   * Validate a deck and return score with breakdown
   */
  async validateDeck (deck) {
    if (!this.validationModelLoaded) {
      console.warn('Validation model not loaded')
      return null
    }

    if (!deck || deck.length < 60) {
      return {
        score: 0,
        grade: 'D',
        message: 'Deck must have 60 cards',
        breakdown: []
      }
    }

    const features = this.extractDeckFeatures(deck)

    // Count unique cards for debugging
    const uniqueCards = new Set(
      deck.map((c) => this.getCardKey(c.name, c.version))
    )

    // DEBUG: Log features to console
    console.log('Validation features:', {
      featureCount: features.length,
      uniqueCardCount: uniqueCards.size,
      singletonRatio: features[0],
      twoOfRatio: features[1],
      threeOfRatio: features[2],
      fourOfRatio: features[3],
      moreThanFourRatio: features[4],
      manaCurvePeak: Math.max(...features.slice(5, 15)),
      characterRatio: features[15],
      inkableRatio: features[25],
      synergyScore: features[36],
      allFeatures: features
    })

    const result = await this.validationModel.evaluateWithBreakdown(features)

    // DEBUG: Log raw score
    console.log('Validation result:', result)

    return result
  }
}
