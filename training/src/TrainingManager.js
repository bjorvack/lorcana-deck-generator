const CardApi = require('./CardApi')
const DeckModel = require('./DeckModel')
const TextEmbedder = require('./TextEmbedder')
const fs = require('fs')
const path = require('path')

module.exports = class TrainingManager {
  constructor() {
    this.cardApi = new CardApi()
    this.model = new DeckModel()
    this.textEmbedder = new TextEmbedder()
    this.cards = []
    this.cardMap = new Map() // Name -> Index
    this.indexMap = new Map() // Index -> Name

    // Updated props for new structure
    this.newDecksToTrain = [] // List of resolved deck objects
    this.trainingDataPath = path.join(__dirname, '..', '..', 'training_data')
    this.trainingStatePath = path.join(
      this.trainingDataPath,
      'training-state.json'
    )
    this.trainingState = null

    // Synergy learning - co-occurrence matrix
    // card_i -> { card_j: normalized_score }
    this.cooccurrenceMatrix = new Map()
    // Track keyword synergies: keyword_i -> { keyword_j: score }
    this.keywordSynergyMatrix = new Map()
    // Track card -> keywords mapping for fast lookup
    this.cardKeywordsMap = new Map()

    // Ability combo tracking
    // Maps card IDs to ability combos they enable/benefit from
    this.abilityComboMap = new Map()
    // Known ability combos in the game
    this.abilityCombos = {
      // Singer decks need singer characters + song actions
      'singer-song': {
        keywords: ['Singer'],
        relatedTypes: ['Action'],
        keywordsNeeded: ['Singer'],
        description: 'Singer characters benefit from song actions'
      },
      // Challenger decks want targets
      'challenger': {
        keywords: ['Challenger'],
        relatedTypes: ['Character'],
        keywordsNeeded: ['Challenger'],
        description: 'Challenger characters need other characters to challenge'
      },
      // Shift decks need cheaper versions
      'shift': {
        keywords: ['Shift'],
        relatedTypes: ['Character'],
        keywordsNeeded: ['Shift'],
        description: 'Shift cards need cheaper version to shift from'
      },
      // Bodyguard protects others
      'bodyguard': {
        keywords: ['Bodyguard'],
        relatedTypes: ['Character'],
        keywordsNeeded: ['Bodyguard'],
        description: 'Bodyguard protects vulnerable characters'
      },
      // Evasive needs challenges
      'evasive': {
        keywords: ['Evasive'],
        relatedTypes: ['Character'],
        keywordsNeeded: ['Evasive'],
        description: 'Evasive characters avoid non-evasive challenges'
      },
      // Rush should attack quickly
      'rush': {
        keywords: ['Rush'],
        relatedTypes: ['Character'],
        keywordsNeeded: ['Rush'],
        description: 'Rush characters can challenge same turn'
      },
      // Resist decks want high damage targets
      'resist': {
        keywords: ['Resist'],
        relatedTypes: ['Character'],
        keywordsNeeded: ['Resist'],
        description: 'Resist reduces incoming damage'
      },
      // Ward needs opponents
      'ward': {
        keywords: ['Ward'],
        relatedTypes: ['Character'],
        keywordsNeeded: ['Ward'],
        description: 'Ward blocks challenging'
      }
    }

    // Curriculum Learning Phases
    // Progressively increase difficulty during training
    // Note: Lorcana only allows max 2 ink colors per deck
    this.curriculumPhase = 0
    this.curriculumPhases = [
      { name: 'single-ink', maxInks: 1, epochs: 5, description: 'Single ink decks only' },
      { name: 'dual-ink-simple', maxInks: 2, minInks: 2, epochs: 10, simpleInks: true, description: 'Simple dual-ink combinations' },
      { name: 'dual-ink', maxInks: 2, minInks: 2, epochs: 15, description: 'All dual-ink combinations' },
      { name: 'full', maxInks: 2, minInks: 2, epochs: -1, description: 'Full deck building' }
    ]
    this.currentEpochInPhase = 0
    this.totalEpochsTrained = 0

    // Ink difficulty mapping - valid Lorcana ink combinations
    // (Amber, Amethyst, Emerald, Ruby, Sapphire, Steel)
    // Single ink for phase 1, dual ink combinations for phase 2+
    this.inkDifficulty = {
      // Single ink
      'amber': 0.5,
      'amethyst': 0.5,
      'emerald': 0.5,
      'ruby': 0.5,
      'sapphire': 0.5,
      'steel': 0.5,
      // Dual ink
      'amber-amethyst': 1.0,
      'amber-emerald': 1.0,
      'amber-ruby': 1.0,
      'amber-sapphire': 1.0,
      'amber-steel': 1.0,
      'amethyst-emerald': 1.0,
      'amethyst-ruby': 1.0,
      'amethyst-sapphire': 1.0,
      'amethyst-steel': 1.0,
      'emerald-ruby': 1.0,
      'emerald-sapphire': 1.0,
      'emerald-steel': 1.0,
      'ruby-sapphire': 1.0,
      'ruby-steel': 1.0,
      'sapphire-steel': 1.0
    }

    // Memory optimization settings
    this.synergyThreshold = 0.05 // Filter out weak synergies (below 5%)
    this.maxSynergiesPerCard = 50 // Limit top synergies per card
  }

  /**
   * Force garbage collection if available
   * Call between heavy processing phases
   */
  async compactMemory () {
    if (global.gc) {
      this.log('Running garbage collection...')
      global.gc()
    }
    // Give event loop time to clean up
    await new Promise(resolve => setImmediate(resolve))
  }

  /**
   * Get current curriculum phase configuration
   */
  getCurriculumPhase () {
    return this.curriculumPhases[this.curriculumPhase]
  }

  /**
   * Update curriculum based on epochs trained
   * Should be called at the start of each epoch
   */
  updateCurriculum () {
    const phase = this.getCurriculumPhase()

    // Check if we should advance to next phase
    if (phase.epochs > 0 && this.currentEpochInPhase >= phase.epochs) {
      if (this.curriculumPhase < this.curriculumPhases.length - 1) {
        this.curriculumPhase++
        this.currentEpochInPhase = 0
        this.log(`📚 Curriculum: Advanced to phase '${this.getCurriculumPhase().name}' - ${this.getCurriculumPhase().description}`)
      }
    }

    this.currentEpochInPhase++
    this.totalEpochsTrained++

    return this.getCurriculumPhase()
  }

  /**
   * Get allowed inks for current curriculum phase
   * Returns array of ink combinations allowed
   */
  getCurriculumAllowedInks () {
    const phase = this.getCurriculumPhase()
    const inkKeys = Object.keys(this.inkDifficulty)

    // Filter based on curriculum phase
    const allowedInks = []
    for (const inkKey of inkKeys) {
      const inks = inkKey.split('-')
      const inkCount = inks.length

      // Check if within phase constraints
      if (inkCount >= phase.minInks && inkCount <= phase.maxInks) {
        // In simple mode, only allow common/easy combos
        if (phase.simpleInks) {
          const difficulty = this.inkDifficulty[inkKey] || 1.0
          if (difficulty <= 1.0) {
            allowedInks.push(inkKey)
          }
        } else {
          allowedInks.push(inkKey)
        }
      }
    }

    return allowedInks
  }

  /**
   * Get difficulty multiplier for current phase
   */
  getCurriculumDifficulty () {
    const phase = this.getCurriculumPhase()
    // Difficulty increases as we progress
    return 1.0 + (this.curriculumPhase * 0.2)
  }

  /**
   * Get curriculum statistics
   */
  getCurriculumStats () {
    return {
      phase: this.getCurriculumPhase().name,
      phaseDescription: this.getCurriculumPhase().description,
      progressInPhase: `${this.currentEpochInPhase}/${this.getCurriculumPhase().epochs}`,
      totalEpochs: this.totalEpochsTrained,
      difficulty: this.getCurriculumDifficulty()
    }
  }

  /**
   * Reset curriculum to beginning
   */
  resetCurriculum () {
    this.curriculumPhase = 0
    this.currentEpochInPhase = 0
    this.totalEpochsTrained = 0
    this.log('📚 Curriculum: Reset to beginning')
  }

  /**
   * Build co-occurrence matrix from training decks
   * Learns which cards frequently appear together in winning/tournament decks
   * @param {Array} decks - Array of deck objects with card entries
   */
  buildCooccurrenceMatrix(decks) {
    this.log('Building card co-occurrence matrix...')

    const pairCounts = new Map()
    const cardCounts = new Map()
    const totalDecks = decks.length

    for (const deck of decks) {
      // Get unique card IDs in this deck
      const cardIds = new Set()
      for (const cardEntry of deck.cards) {
        const key = this.getCardKey(cardEntry.name, cardEntry.version)
        const cardId = this.cardMap.get(key)
        if (cardId !== undefined) {
          cardIds.add(cardId)
        }
      }

      // Count individual cards
      for (const cardId of cardIds) {
        cardCounts.set(cardId, (cardCounts.get(cardId) || 0) + 1)
      }

      // Count pairs (symmetric) - limit to reduce memory
      const cardArray = Array.from(cardIds)
      const maxPairs = 1000 // Limit pairs per deck to save memory
      let pairCount = 0
      for (let i = 0; i < cardArray.length && pairCount < maxPairs; i++) {
        for (let j = i + 1; j < cardArray.length && pairCount < maxPairs; j++) {
          const pairKey = `${cardArray[i]}-${cardArray[j]}`
          pairCounts.set(pairKey, (pairCounts.get(pairKey) || 0) + 1)
          pairCount++
        }
      }
    }

    // Normalize and filter: P(card_j | card_i) = count(pair) / count(card_i)
    // Only keep synergies above threshold
    const threshold = this.synergyThreshold || 0.05
    
    for (const [pairKey, pairCount] of pairCounts) {
      const [id1, id2] = pairKey.split('-').map(Number)
      const count1 = cardCounts.get(id1) || 1

      // Score = normalized co-occurrence
      const score = pairCount / count1

      // Skip low-synergy pairs to save memory
      if (score < threshold) continue

      // Store symmetrically with limit
      if (!this.cooccurrenceMatrix.has(id1)) {
        this.cooccurrenceMatrix.set(id1, new Map())
      }
      if (!this.cooccurrenceMatrix.has(id2)) {
        this.cooccurrenceMatrix.set(id2, new Map())
      }

      // Limit synergies per card
      const synergies1 = this.cooccurrenceMatrix.get(id1)
      const synergies2 = this.cooccurrenceMatrix.get(id2)
      
      if (synergies1.size < (this.maxSynergiesPerCard || 50)) {
        synergies1.set(id2, score)
      }
      if (synergies2.size < (this.maxSynergiesPerCard || 50)) {
        synergies2.set(id1, score)
      }
    }

    // Store card counts for baseline
    this.deckCardCounts = cardCounts

    this.log(`  Co-occurrence matrix: ${this.cooccurrenceMatrix.size} cards tracked`)
    this.log(`  Pair counts: ${pairCounts.size} unique pairs (filtered by threshold ${threshold})`)
  }

  /**
   * Build keyword synergy matrix from training decks
   * Learns which keyword combinations work well together
   * @param {Array} decks - Array of deck objects
   */
  buildKeywordSynergyMatrix(decks) {
    this.log('Building keyword synergy matrix...')

    const keywordPairCounts = new Map()
    const keywordCounts = new Map()

    // All known keywords in the game
    const allKeywords = ['Ward', 'Evasive', 'Bodyguard', 'Resist', 'Singer', 'Shift', 'Reckless', 'Challenger', 'Rush', 'Boost']

    for (const deck of decks) {
      // Collect all keywords present in deck
      const deckKeywords = new Set()

      for (const cardEntry of deck.cards) {
        const key = this.getCardKey(cardEntry.name, cardEntry.version)
        const cardId = this.cardMap.get(key)
        if (cardId !== undefined) {
          const card = this.indexMap.get(cardId)
          if (card && card.keywords) {
            for (const kw of card.keywords) {
              if (allKeywords.includes(kw)) {
                deckKeywords.add(kw)
                // Store card -> keywords mapping
                if (!this.cardKeywordsMap.has(cardId)) {
                  this.cardKeywordsMap.set(cardId, new Set())
                }
                this.cardKeywordsMap.get(cardId).add(kw)
              }
            }
          }
        }
      }

      // Count individual keywords
      for (const kw of deckKeywords) {
        keywordCounts.set(kw, (keywordCounts.get(kw) || 0) + 1)
      }

      // Count keyword pairs
      const kwArray = Array.from(deckKeywords)
      for (let i = 0; i < kwArray.length; i++) {
        for (let j = i + 1; j < kwArray.length; j++) {
          const pairKey = [kwArray[i], kwArray[j]].sort().join('|')
          keywordPairCounts.set(pairKey, (keywordPairCounts.get(pairKey) || 0) + 1)
        }
      }
    }

    // Normalize and store
    for (const [pairKey, count] of keywordPairCounts) {
      const [kw1, kw2] = pairKey.split('|')
      const total1 = keywordCounts.get(kw1) || 1

      const score = count / total1

      if (!this.keywordSynergyMatrix.has(kw1)) {
        this.keywordSynergyMatrix.set(kw1, new Map())
      }
      if (!this.keywordSynergyMatrix.has(kw2)) {
        this.keywordSynergyMatrix.set(kw2, new Map())
      }

      this.keywordSynergyMatrix.get(kw1).set(kw2, score)
      this.keywordSynergyMatrix.get(kw2).set(kw1, score)
    }

    this.log(`  Keyword synergy matrix: ${this.keywordSynergyMatrix.size} keywords tracked`)
  }

  /**
   * Get synergy score between two cards
   * @param {Number} cardId1 - First card index
   * @param {Number} cardId2 - Second card index
   * @returns {Number} Synergy score (0-1, higher is better)
   */
  getCardSynergy(cardId1, cardId2) {
    const synergies1 = this.cooccurrenceMatrix.get(cardId1)
    if (!synergies1) return 0

    const score = synergies1.get(cardId2)
    return score || 0
  }

  /**
   * Get synergy score for adding a card to existing deck
   * @param {Number} cardId - Card to add
   * @param {Array} currentDeck - Array of card IDs already in deck
   * @returns {Number} Average synergy with current deck
   */
  getDeckSynergyScore(cardId, currentDeck) {
    if (currentDeck.length === 0) return 0

    let totalSynergy = 0
    let count = 0

    for (const existingCardId of currentDeck) {
      const synergy = this.getCardSynergy(cardId, existingCardId)
      if (synergy > 0) {
        totalSynergy += synergy
        count++
      }
    }

    return count > 0 ? totalSynergy / count : 0
  }

  /**
   * Get keyword synergy score for a card based on deck's current keywords
   * @param {Number} cardId - Card to evaluate
   * @param {Set} deckKeywords - Keywords already in deck
   * @returns {Number} Keyword synergy score
   */
  getKeywordSynergyScore(cardId, deckKeywords) {
    const cardKeywords = this.cardKeywordsMap.get(cardId)
    if (!cardKeywords || cardKeywords.size === 0) return 0
    if (deckKeywords.size === 0) return 0

    let totalSynergy = 0
    let count = 0

    for (const cardKw of cardKeywords) {
      const deckSynergies = this.keywordSynergyMatrix.get(cardKw)
      if (deckSynergies) {
        for (const deckKw of deckKeywords) {
          const score = deckSynergies.get(deckKw)
          if (score) {
            totalSynergy += score
            count++
          }
        }
      }
    }

    return count > 0 ? totalSynergy / count : 0
  }

  /**
   * Calculate overall synergy reward for a complete deck
   * @param {Array} deckIndices - Array of card IDs
   * @returns {Number} Synergy score (0-1)
   */
  calculateDeckSynergy(deckIndices) {
    if (deckIndices.length < 2) return 0

    // Calculate pairwise synergies
    let totalSynergy = 0
    let pairCount = 0

    // Sample pairs for efficiency (don't check all n^2)
    const sampleSize = Math.min(100, deckIndices.length)
    for (let i = 0; i < sampleSize; i++) {
      const idx1 = Math.floor(Math.random() * deckIndices.length)
      let idx2 = Math.floor(Math.random() * deckIndices.length)
      while (idx2 === idx1) {
        idx2 = Math.floor(Math.random() * deckIndices.length)
      }

      const synergy = this.getCardSynergy(deckIndices[idx1], deckIndices[idx2])
      if (synergy > 0) {
        totalSynergy += synergy
        pairCount++
      }
    }

    return pairCount > 0 ? Math.min(1, totalSynergy / pairCount * 10) : 0
  }

  /**
   * Initialize ability combo mapping from cards
   * Builds a map of which cards enable/participate in which ability combos
   */
  initializeAbilityCombos() {
    this.log('Initializing ability combo mappings...')

    for (const [cardId, card] of this.indexMap) {
      const combos = []

      // Check each ability combo
      for (const [comboName, comboDef] of Object.entries(this.abilityCombos)) {
        // Check if card has any of the combo's keywords
        if (card.keywords) {
          for (const keyword of card.keywords) {
            if (comboDef.keywords.includes(keyword)) {
              combos.push(comboName)
              break
            }
          }
        }

        // Check if card has related types
        if (card.types) {
          for (const type of card.types) {
            if (comboDef.relatedTypes.includes(type)) {
              // Only add if card also has relevant keywords or is the right type
              if (card.keywords && card.keywords.some(k => comboDef.keywords.includes(k))) {
                if (!combos.includes(comboName)) {
                  combos.push(comboName)
                }
              }
            }
          }
        }
      }

      if (combos.length > 0) {
        this.abilityComboMap.set(cardId, combos)
      }
    }

    this.log(`  Ability combos mapped for ${this.abilityComboMap.size} cards`)
  }

  /**
   * Calculate ability combo score for a deck
   * Rewards having complete ability combos (e.g., singers + songs)
   * @param {Array} deckIndices - Array of card IDs
   * @returns {Number} Combo score (0-1)
   */
  calculateAbilityComboScore(deckIndices) {
    if (deckIndices.length < 4) return 0

    // Track which combos are partially or fully formed
    const comboCounts = {}
    const comboCardCounts = {}

    for (const cardId of deckIndices) {
      const combos = this.abilityComboMap.get(cardId)
      if (combos) {
        for (const combo of combos) {
          comboCounts[combo] = (comboCounts[combo] || 0) + 1
          if (!comboCardCounts[combo]) {
            comboCardCounts[combo] = new Set()
          }
          comboCardCounts[combo].add(cardId)
        }
      }
    }

    // Score each combo
    let totalScore = 0
    let comboCount = 0

    for (const [comboName, comboDef] of Object.entries(this.abilityCombos)) {
      const cardCount = comboCardCounts[comboName]?.size || 0

      // A combo is "complete" with enough cards
      // Singer needs: 4+ singer characters + 4+ songs (simplified)
      // Others need: 2+ cards with that keyword
      let threshold
      if (comboName === 'singer-song') {
        threshold = 4 // At least 4 cards involved in the singer combo
      } else {
        threshold = 2 // At least 2 cards with the keyword
      }

      if (cardCount >= threshold) {
        // Full synergy bonus
        totalScore += 1.0
      } else if (cardCount >= threshold / 2) {
        // Partial synergy
        totalScore += 0.5
      }
      comboCount++
    }

    return comboCount > 0 ? Math.min(1, totalScore / Math.min(comboCount, 4)) : 0
  }

  /**
   * Get recommended cards for completing ability combos
   * @param {Array} deckIndices - Current deck
   * @param {Array} allowedInks - Allowed ink colors
   * @returns {Array} Card IDs that would complete combos
   */
  getComboFillerCards(deckIndices, allowedInks) {
    // Find which combos are partially formed
    const activeCombos = new Set()
    const neededCombos = {}

    for (const cardId of deckIndices) {
      const combos = this.abilityComboMap.get(cardId)
      if (combos) {
        for (const combo of combos) {
          activeCombos.add(combo)
          if (!neededCombos[combo]) {
            neededCombos[combo] = { current: 0, needed: 4 }
          }
          neededCombos[combo].current++
        }
      }
    }

    // Find cards that complete these combos
    const fillerCards = []
    for (const [cardId, card] of this.indexMap) {
      if (deckIndices.includes(cardId)) continue
      if (allowedInks && !allowedInks.includes(card.ink)) continue

      const combos = this.abilityComboMap.get(cardId)
      if (combos) {
        for (const combo of combos) {
          if (activeCombos.has(combo) && neededCombos[combo].current < neededCombos[combo].needed) {
            fillerCards.push(cardId)
            break
          }
        }
      }
    }

    return fillerCards
  }

  log(message) {
    console.log(`[${new Date().toLocaleTimeString()}] ${message}`)
  }

  async startTraining(
    epochs = 10,
    fullRetrain = false,
    continueTraining = false,
    balanceClasses = true
  ) {
    this.log(`Starting training process with ${epochs} epochs...`)
    this.log(
      `Mode: ${fullRetrain
        ? 'Full retrain'
        : continueTraining
          ? 'Continue training'
          : 'Incremental training'
      }`
    )

    // Load training state
    this.loadTrainingState()
    if (fullRetrain) {
      this.log('Full retrain requested - clearing training state...')
      this.trainingState = this.getInitialTrainingState()
      this.newDecksToTrain = []
    }

    // Initialize hash set for deduplication
    if (!this.trainingState.trainedDeckHashes) {
      this.trainingState.trainedDeckHashes = []
    }
    // Convert to Set for O(1) lookups during runtime
    this.deckHashSet = new Set(this.trainingState.trainedDeckHashes)

    // 1. Fetch Cards
    if (this.cards.length === 0) {
      this.log('Fetching cards...')
      this.cards = await this.cardApi.getCards()
      this.log(`Fetched ${this.cards.length} cards.`)

      // Build Card Maps
      this.cards.forEach((card) => {
        const key = this.getCardKey(card.name, card.version)
        if (!this.cardMap.has(key)) {
          const id = this.cardMap.size
          this.cardMap.set(key, id)
          this.indexMap.set(id, card)
        }
      })
      this.log(`Unique cards indexed: ${this.cardMap.size}`)

      // Initialize ability combos from cards
      this.initializeAbilityCombos()

      // Build text vocabulary
      this.log('Building text vocabulary...')
      this.textEmbedder.buildVocabulary(this.cards)
      const vocabPath = path.join(this.trainingDataPath, 'vocabulary.json')
      this.textEmbedder.save(vocabPath)
    } else {
      this.log('Cards already loaded.')
    }

    // 2. Load Training Data (New Logic)
    await this.loadTrainingData(fullRetrain || continueTraining)

    if (this.newDecksToTrain.length === 0) {
      this.log('No new data loaded; skipping training run.')
      return
    }

    // 2c. Build synergy matrices from training data
    this.buildCooccurrenceMatrix(this.newDecksToTrain)
    await this.compactMemory() // Clean up after heavy operation
    
    this.buildKeywordSynergyMatrix(this.newDecksToTrain)
    await this.compactMemory() // Clean up after heavy operation

    // 2b. Compute ink distribution for balancing
    const inkDistribution = new Map()
    for (const deck of this.newDecksToTrain) {
      const inkPath = this.getInkPath(deck.inks)
      if (inkPath) {
        inkDistribution.set(inkPath, (inkDistribution.get(inkPath) || 0) + 1)
      }
    }

    // Calculate balancing multipliers
    let balancingMultipliers = new Map()
    if (balanceClasses && inkDistribution.size > 0) {
      const maxCount = Math.max(...inkDistribution.values())
      this.log('--- Ink Distribution ---')
      for (const [ink, count] of Array.from(inkDistribution.entries()).sort((a, b) => b[1] - a[1])) {
        const multiplier = Math.min(Math.ceil(maxCount / count), 20) // Cap at 20x
        balancingMultipliers.set(ink, multiplier)
        this.log(`  ${ink}: ${count} decks (${multiplier}x repetitions)`)
      }
      this.log('------------------------')
    }

    // 3. Process Decks
    this.log('Processing decks...')
    const sequences = []
    const featureSequences = []
    const textSequences = []

    let processedDecks = 0

    for (const deck of this.newDecksToTrain) {
      const deckIndices = []

      for (const cardEntry of deck.cards) {
        const key = this.getCardKey(cardEntry.name, cardEntry.version)
        if (this.cardMap.has(key)) {
          const index = this.cardMap.get(key)
          for (let i = 0; i < cardEntry.amount; i++) {
            deckIndices.push(index)
          }
        }
      }

      if (deckIndices.length > 0) {
        // Hash check again (redundant but safe)
        const deckHash = deck.hash || this.getDeckHash(deckIndices)

        // Calculate repetitions based on balancing
        const inkPath = this.getInkPath(deck.inks)
        const baseRepetitions = 5
        const multiplier = balanceClasses && inkPath ? (balancingMultipliers.get(inkPath) || 1) : 1
        const totalRepetitions = baseRepetitions * multiplier

        // Create shuffled versions using Fisher-Yates algorithm
        for (let k = 0; k < totalRepetitions; k++) {
          const shuffledIndices = this.fisherYatesShuffle([...deckIndices])

          const seqIndices = []
          const seqFeatures = []
          const seqTextIndices = []

          const currentStats = this.getInitialDeckStats()
          const cardCounts = new Map()

          for (const index of shuffledIndices) {
            const card = this.indexMap.get(index)
            const copiesSoFar = cardCounts.get(index) || 0

            this.updateDeckStats(currentStats, card)
            const features = this.extractCardFeatures(
              card,
              currentStats,
              copiesSoFar
            )
            const textIndices = this.textEmbedder.cardToTextIndices(card)

            seqIndices.push(index)
            seqFeatures.push(features)
            seqTextIndices.push(textIndices)

            cardCounts.set(index, copiesSoFar + 1)
          }

          sequences.push(seqIndices)
          featureSequences.push(seqFeatures)
          textSequences.push(seqTextIndices)
        }

        // Mark as trained
        this.deckHashSet.add(deckHash)
      }
      processedDecks++
    }

    this.log(
      `Generated ${sequences.length} sequences from ${processedDecks} decks.`
    )

    if (sequences.length === 0) {
      this.log('No sequences generated. Skipping.')
      return
    }

    // 4. Train Model
    if (!this.model.model) {
      this.log('Initializing new model...')
      this.log('Building card embedding matrix...')
      const embeddingMatrix = this.buildCardEmbeddingMatrix()
      await this.model.initialize(this.cardMap.size, embeddingMatrix)
    } else {
      this.log('Continuing training on existing model...')
    }

    this.log('Training model...')

    // Helper to shuffle data arrays in sync
    const shuffleData = (seqs) => {
      const indices = seqs.map((_, i) => i)
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]]
      }
      return {
        shuffledSeqs: indices.map((i) => seqs[i])
      }
    }

    const MAX_BATCH_SIZE = 5000
    if (sequences.length > MAX_BATCH_SIZE) {
      this.log(
        `Large dataset detected (${sequences.length} sequences). Training in batches of ${MAX_BATCH_SIZE}...`
      )

      this.log('Shuffling training data...')
      const { shuffledSeqs } = shuffleData(sequences)

      const numBatches = Math.ceil(sequences.length / MAX_BATCH_SIZE)

      for (let epoch = 0; epoch < epochs; epoch++) {
        this.log(`Global Epoch ${epoch + 1}/${epochs}`)

        for (let batchIdx = 0; batchIdx < numBatches; batchIdx++) {
          const start = batchIdx * MAX_BATCH_SIZE
          const end = Math.min(
            (batchIdx + 1) * MAX_BATCH_SIZE,
            sequences.length
          )

          const batchSequences = shuffledSeqs.slice(start, end)

          await this.model.train(batchSequences, 1, (e, logs) => {
            if (batchIdx % 5 === 0 || batchIdx === numBatches - 1) {
              this.log(
                `  Batch ${batchIdx + 1
                }/${numBatches}: loss = ${logs.loss.toFixed(4)}`
              )
            }
          })
        }
        await this.saveModel()
        this.log(`  ✓ Checkpoint saved (Epoch ${epoch + 1})`)
      }
    } else {
      await this.model.train(sequences, epochs, async (epoch, logs) => {
        this.log(
          `Epoch ${epoch + 1}/${epochs}: loss = ${logs.loss.toFixed(4)}`
        )
        await this.saveModel()
      })
    }

    this.log('Training complete!')
    await this.saveModel()

    this.updateTrainingState(epochs)
    this.saveTrainingState()
  }

  // --- NEW: Load Logic ---
  async loadTrainingData(forceLoadAll = false) {
    this.log('Scanning for tournament data...')
    this.newDecksToTrain = []

    const tournamentsDir = path.join(this.trainingDataPath, 'tournaments')
    if (!fs.existsSync(tournamentsDir)) {
      this.log('Tournaments directory not found.')
      return
    }

    const yearFiles = fs.readdirSync(tournamentsDir).filter(f => f.endsWith('.json'))
    this.log(`Found ${yearFiles.length} year files.`)

    let skippedDecks = 0
    let loadedDecksCount = 0

    for (const file of yearFiles) {
      try {
        const filePath = path.join(tournamentsDir, file)
        const tournaments = JSON.parse(fs.readFileSync(filePath, 'utf8'))

        for (const tournament of tournaments) {
          if (tournament.decks) {
            for (const deckRef of tournament.decks) {
              // Check if trained
              if (!forceLoadAll && this.deckHashSet.has(deckRef.hash)) {
                skippedDecks++
                continue
              }

              // Load deck content
              const inkPath = this.getInkPath(deckRef.inks)
              if (!inkPath) continue // invalid/unknown inks

              // VALIDATION: Lorcana only allows max 2 inks
              const inkCount = deckRef.inks ? deckRef.inks.length : 0
              if (inkCount > 2) {
                skippedDecks++
                continue // Skip decks with more than 2 inks
              }

              const deckPath = path.join(this.trainingDataPath, 'decks', inkPath, `${deckRef.hash}.json`)

              if (fs.existsSync(deckPath)) {
                const deckContent = JSON.parse(fs.readFileSync(deckPath, 'utf8'))
                this.newDecksToTrain.push(deckContent)
                loadedDecksCount++

                // Deduplication: Add to set temporarily so we don't load the same deck twice in this session
                // (Even if it appears in multiple tournaments)
                if (!forceLoadAll) {
                  this.deckHashSet.add(deckRef.hash)
                }
              }
            }
          }
        }
      } catch (e) {
        this.log(`Error reading ${file}: ${e.message}`)
      }
    }

    this.log(`Loaded ${loadedDecksCount} new decks to train. Skipped ${skippedDecks} already trained/duplicate decks.`)

    // --- Synthetic Data Generation for Missing/Underrepresented Combinations ---
    if (this.cards.length > 0) {
      const MIN_DECKS_THRESHOLD = 10
      const SYNTHETIC_DECKS_FOR_MISSING = 10

      // All valid Lorcana inks (Amber, Amethyst, Emerald, Ruby, Sapphire, Steel)
      const INKS = ['amber', 'amethyst', 'emerald', 'ruby', 'sapphire', 'steel']
      const allCombinations = []
      // Single ink
      for (const ink of INKS) {
        allCombinations.push([ink])
      }
      // Two-ink (max 2 inks per Lorcana rules)
      for (let i = 0; i < INKS.length; i++) {
        for (let j = i + 1; j < INKS.length; j++) {
          allCombinations.push([INKS[i], INKS[j]])
        }
      }

      // Count loaded decks by ink combination
      const inkCounts = new Map()
      const decksByInk = new Map()
      for (const deck of this.newDecksToTrain) {
        const inkPath = this.getInkPath(deck.inks)
        if (inkPath) {
          inkCounts.set(inkPath, (inkCounts.get(inkPath) || 0) + 1)
          if (!decksByInk.has(inkPath)) {
            decksByInk.set(inkPath, [])
          }
          decksByInk.get(inkPath).push(deck)
        }
      }

      let syntheticCount = 0
      let augmentedCount = 0

      for (const combo of allCombinations) {
        const inkPath = combo.slice().sort().join('-')
        const count = inkCounts.get(inkPath) || 0

        if (count === 0) {
          // Missing combination: generate synthetic decks
          this.log(`  Generating ${SYNTHETIC_DECKS_FOR_MISSING} synthetic decks for missing: ${inkPath}`)
          for (let i = 0; i < SYNTHETIC_DECKS_FOR_MISSING; i++) {
            const syntheticDeck = this.generateSyntheticDeckForInks(combo)
            if (syntheticDeck) {
              this.newDecksToTrain.push(syntheticDeck)
              syntheticCount++
            }
          }
        } else if (count < MIN_DECKS_THRESHOLD) {
          // Underrepresented: augment existing decks
          const needed = MIN_DECKS_THRESHOLD - count
          const existingDecks = decksByInk.get(inkPath) || []
          this.log(`  Augmenting ${needed} variations for underrepresented: ${inkPath} (has ${count})`)
          for (let i = 0; i < needed && existingDecks.length > 0; i++) {
            const baseDeck = existingDecks[i % existingDecks.length]
            const augmented = this.augmentDeckWithVariation(baseDeck)
            if (augmented) {
              this.newDecksToTrain.push(augmented)
              augmentedCount++
            }
          }
        }
      }

      if (syntheticCount > 0 || augmentedCount > 0) {
        this.log(`Added ${syntheticCount} synthetic + ${augmentedCount} augmented decks`)
        this.log(`Total decks to train: ${this.newDecksToTrain.length}`)
      }
    }

    // If we are doing a force load, we need to reset the hash set so training actually happens
    if (forceLoadAll) {
      this.deckHashSet = new Set()
      // We re-add them as we process
    }
  }

  getInkPath(inks) {
    if (!inks || inks.length === 0) return null
    return inks.slice().sort().join('-')
  }

  // --- EXISTING HELPERS ---

  buildCardEmbeddingMatrix() {
    const matrix = []
    for (let i = 0; i < this.cardMap.size; i++) {
      const card = this.indexMap.get(i)
      if (!card) {
        matrix.push(new Array(64).fill(0))
        continue
      }
      const features = this.extractStaticCardFeatures(card)
      matrix.push(features)
    }
    return matrix
  }

  extractStaticCardFeatures(card) {
    const features = []
    features.push(Math.min(card.cost, 10) / 10)
    features.push(card.inkwell ? 1 : 0)
    features.push(Math.min(card.lore || 0, 5) / 5)
    features.push(Math.min(card.strength || 0, 10) / 10)
    features.push(Math.min(card.willpower || 0, 10) / 10)
    const inkColors = ['Amber', 'Amethyst', 'Emerald', 'Ruby', 'Sapphire', 'Steel']
    inkColors.forEach((ink) => features.push(card.ink === ink ? 1 : 0))
    const types = ['Character', 'Action', 'Item', 'Location']
    const cardType = card.types && card.types.length > 0 ? card.types[0] : ''
    types.forEach((type) => features.push(cardType === type ? 1 : 0))
    const keywords = ['Bodyguard', 'Reckless', 'Rush', 'Ward', 'Evasive', 'Resist', 'Challenger', 'Singer', 'Shift', 'Support']
    keywords.forEach((kw) => {
      const hasKw = (card.keywords && card.keywords.some((k) => k.includes(kw))) || (card.text && card.text.includes(kw))
      features.push(hasKw ? 1 : 0)
    })
    const classifications = ['Hero', 'Villain', 'Dreamborn', 'Storyborn', 'Floodborn']
    classifications.forEach((cls) => {
      features.push(card.classifications && card.classifications.includes(cls) ? 1 : 0)
    })
    const textEmbedding = this.computeSimpleTextEmbedding(card, 98)
    features.push(...textEmbedding)
    return features
  }

  computeSimpleTextEmbedding(card, dim) {
    const text = `${card.name} ${card.text || ''} ${card.keywords ? card.keywords.join(' ') : ''
      }`.toLowerCase()
    const embedding = new Array(dim).fill(0)
    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i)
      embedding[charCode % dim] += 1
    }
    const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0))
    if (norm > 0) {
      for (let i = 0; i < dim; i++) embedding[i] /= norm
    }
    return embedding
  }

  getInitialTrainingState() {
    return {
      lastTrainingDate: null,
      totalTrainings: 0,
      trainedFiles: [], // Deprecated but kept for compatibility
      trainedDeckHashes: [],
      trainingHistory: []
    }
  }

  loadTrainingState() {
    if (fs.existsSync(this.trainingStatePath)) {
      try {
        this.trainingState = JSON.parse(
          fs.readFileSync(this.trainingStatePath, 'utf8')
        )
        // Ensure hashes array exists
        if (!this.trainingState.trainedDeckHashes) {
          this.trainingState.trainedDeckHashes = []
        }
      } catch (e) {
        this.log(`Warning: Could not load training state: ${e.message}`)
        this.trainingState = this.getInitialTrainingState()
      }
    } else {
      this.log('No existing training state found. Starting fresh.')
      this.trainingState = this.getInitialTrainingState()
    }
  }

  updateTrainingState(epochs) {
    const now = new Date().toISOString()

    // Update training history
    this.trainingState.trainingHistory.push({
      date: now,
      epochs,
      newDecks: this.newDecksToTrain.length,
      totalDecks: this.deckHashSet.size
    })

    this.trainingState.lastTrainingDate = now
    this.trainingState.totalTrainings++

    // Save updated hashes
    this.trainingState.trainedDeckHashes = Array.from(this.deckHashSet)
  }

  saveTrainingState() {
    try {
      fs.writeFileSync(
        this.trainingStatePath,
        JSON.stringify(this.trainingState, null, 2)
      )
      this.log(`Training state saved to ${this.trainingStatePath}`)
    } catch (e) {
      this.log(`Error saving training state: ${e.message}`)
    }
  }

  getInitialDeckStats() {
    return {
      totalCards: 0,
      inkableCount: 0,
      costCounts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      inkableCostCounts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      typeCounts: { character: 0, action: 0, item: 0, location: 0 },
      inkCounts: { Amber: 0, Amethyst: 0, Emerald: 0, Ruby: 0, Sapphire: 0, Steel: 0 }
    }
  }

  updateDeckStats(stats, card) {
    stats.totalCards++
    if (card.inkwell) stats.inkableCount++
    let cIdx = Math.max(0, Math.min(card.cost - 1, 9))
    if (card.cost === 0) cIdx = 0
    stats.costCounts[cIdx]++
    if (card.inkwell) stats.inkableCostCounts[cIdx]++
    if (card.ink) {
      if (!stats.inkCounts[card.ink]) stats.inkCounts[card.ink] = 0
      stats.inkCounts[card.ink]++
    }
    if (card.type) {
      const t = card.type.toLowerCase()
      if (stats.typeCounts[t] !== undefined) stats.typeCounts[t]++
    }
  }

  extractCardFeatures(card, stats, copiesSoFar = 0) {
    const features = []
    features.push(Math.min(card.cost, 10) / 10)
    features.push(card.inkwell ? 1 : 0)
    features.push(Math.min(card.lore || 0, 5) / 5)
    features.push(Math.min(card.strength || 0, 10) / 10)
    features.push(Math.min(card.willpower || 0, 10) / 10)
    const inkColors = ['Amber', 'Amethyst', 'Emerald', 'Ruby', 'Sapphire', 'Steel']
    inkColors.forEach((ink) => { features.push(card.ink === ink ? 1 : 0) })
    const types = ['Character', 'Action', 'Item', 'Location']
    const cardType = card.types && card.types.length > 0 ? card.types[0] : ''
    types.forEach((type) => { features.push(cardType === type ? 1 : 0) })
    const keywords = ['Bodyguard', 'Reckless', 'Rush', 'Ward', 'Evasive', 'Resist', 'Challenger', 'Singer', 'Shift', 'Boost']
    keywords.forEach((kw) => {
      const propName = `has${kw}`
      if (card[propName] !== undefined) {
        features.push(card[propName] ? 1 : 0)
      } else {
        const hasKw = card.keywords && card.keywords.some((k) => k.includes(kw))
        features.push(hasKw ? 1 : 0)
      }
    })
    features.push(Math.min(card.resistAmount || 0, 10) / 10)
    features.push(Math.min(card.challengerAmount || 0, 10) / 10)
    features.push(Math.min(card.boostAmount || 0, 10) / 10)
    features.push(Math.min(card.moveCost || 0, 10) / 10)
    const commonClassifications = ['Hero', 'Villain', 'Dreamborn', 'Storyborn', 'Floodborn']
    commonClassifications.forEach((cls) => {
      features.push(card.classifications && card.classifications.includes(cls) ? 1 : 0)
    })
    features.push(Math.min(copiesSoFar, 4) / 4)
    const total = Math.max(1, stats.totalCards)
    features.push(stats.inkableCount / total)
    stats.costCounts.forEach((count) => { features.push(count / total) })
    Object.values(stats.typeCounts).forEach((count) => { features.push(count / total) })
    inkColors.forEach((ink) => { features.push((stats.inkCounts[ink] || 0) / total) })
    stats.inkableCostCounts.forEach((count) => { features.push(count / total) })
    return features
  }

  async saveModel() {
    this.log('Saving model to disk...')
    const modelPath = path.join(this.trainingDataPath, 'deck-generator-model')
    await this.model.saveModel(modelPath)
    this.log(`Model saved to ${modelPath}`)
  }

  getCardKey(name, version) {
    return `${name}|${version || ''}`.toLowerCase()
  }

  getDeckHash(deckIndices) {
    const counts = new Map()
    for (const idx of deckIndices) {
      counts.set(idx, (counts.get(idx) || 0) + 1)
    }
    const sortedIds = Array.from(counts.keys()).sort((a, b) => a - b)
    return sortedIds.map((id) => `${id}:${counts.get(id)}`).join('|')
  }

  async buildInitialDeckHashes() {
    // Deprecated for new structure
    return []
  }

  extractDeckFeatures(deckIndices) {
    const features = []
    const copyDistribution = [0, 0, 0, 0, 0]
    const cardCounts = new Map()
    for (const idx of deckIndices) {
      cardCounts.set(idx, (cardCounts.get(idx) || 0) + 1)
    }
    const uniqueCardCount = cardCounts.size
    features.push(uniqueCardCount / 20)
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

    // Additional features
    const costCounts = Array(10).fill(0)
    let inkableCount = 0
    const totalCards = deckIndices.length
    const typeCounts = { character: 0, action: 0, item: 0, location: 0 }
    const inkCounts = { Amber: 0, Amethyst: 0, Emerald: 0, Ruby: 0, Sapphire: 0, Steel: 0 }
    const keywordCounts = { Ward: 0, Evasive: 0, Bodyguard: 0, Resist: 0, Singer: 0, Shift: 0, Reckless: 0, Challenger: 0, Rush: 0 }
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
      if (card.ink && inkCounts[card.ink] !== undefined) inkCounts[card.ink]++
      for (const keyword of Object.keys(keywordCounts)) {
        const propName = `has${keyword}`
        if (card[propName] || (card.keywords && card.keywords.some((k) => k.includes(keyword)))) {
          keywordCounts[keyword]++
        }
      }
      if (card.classifications) {
        for (const cls of card.classifications) {
          classificationCounts.set(cls, (classificationCounts.get(cls) || 0) + 1)
        }
      }
    }
    costCounts.forEach((count) => features.push(count / totalCards))
    Object.values(typeCounts).forEach((count) => features.push(count / totalCards))
    Object.values(inkCounts).forEach((count) => features.push(count / totalCards))
    features.push(inkableCount / totalCards)
    Object.values(keywordCounts).forEach((count) => features.push(count / totalCards))
    features.push(classificationCounts.size / 10)
    const avgClassificationSharing = classificationCounts.size > 0
      ? Array.from(classificationCounts.values()).reduce((a, b) => a + b, 0) / classificationCounts.size / totalCards
      : 0
    features.push(avgClassificationSharing)
    return features
  }

  extractDeckFeaturesWithEmbeddings(deckIndices) {
    const numericFeatures = this.extractDeckFeatures(deckIndices)
    const embeddings = []
    for (const idx of deckIndices) {
      const card = this.indexMap.get(idx)
      if (!card || !card.embedding) continue
      embeddings.push(card.embedding)
    }
    if (embeddings.length === 0) {
      const embeddingDim = 32
      return numericFeatures.concat(Array(embeddingDim).fill(0), Array(embeddingDim).fill(0), Array(embeddingDim).fill(0))
    }
    const embeddingDim = embeddings[0].length
    const meanEmbedding = Array(embeddingDim).fill(0)
    const maxEmbedding = Array(embeddingDim).fill(-Infinity)
    for (const emb of embeddings) {
      for (let i = 0; i < embeddingDim; i++) {
        meanEmbedding[i] += emb[i]
        maxEmbedding[i] = Math.max(maxEmbedding[i], emb[i])
      }
    }
    for (let i = 0; i < embeddingDim; i++) {
      meanEmbedding[i] /= embeddings.length
    }
    const varianceEmbedding = Array(embeddingDim).fill(0)
    for (const emb of embeddings) {
      for (let i = 0; i < embeddingDim; i++) {
        const diff = emb[i] - meanEmbedding[i]
        varianceEmbedding[i] += diff * diff
      }
    }
    for (let i = 0; i < embeddingDim; i++) {
      varianceEmbedding[i] /= embeddings.length
    }
    return numericFeatures.concat(meanEmbedding, maxEmbedding, varianceEmbedding)
  }

  generateFakeDeck(strategy = 'random') {
    const deckIndices = []
    const deckSize = 60

    if (strategy === 'pure_random') {
      const cardPool = Array.from(this.cardMap.values())
      const cardCounts = new Map()
      while (deckIndices.length < deckSize) {
        const randomIdx = cardPool[Math.floor(Math.random() * cardPool.length)]
        const currentCount = cardCounts.get(randomIdx) || 0
        const card = this.indexMap.get(randomIdx)
        const maxAmount = card?.maxAmount || 4
        if (currentCount < maxAmount) {
          deckIndices.push(randomIdx)
          cardCounts.set(randomIdx, currentCount + 1)
        }
      }
    } else if (strategy === 'ink_constrained') {
      const inks = ['Amber', 'Amethyst', 'Emerald', 'Ruby', 'Sapphire', 'Steel']
      const chosenInks = []
      const inkCount = Math.random() < 0.5 ? 1 : 2
      for (let i = 0; i < inkCount; i++) {
        const ink = inks[Math.floor(Math.random() * inks.length)]
        if (!chosenInks.includes(ink)) chosenInks.push(ink)
      }
      const cardPool = []
      for (const [idx, card] of this.indexMap.entries()) {
        if (chosenInks.includes(card.ink)) {
          cardPool.push(idx)
        }
      }
      const cardCounts = new Map()
      while (deckIndices.length < deckSize && cardPool.length > 0) {
        const randomIdx = cardPool[Math.floor(Math.random() * cardPool.length)]
        const currentCount = cardCounts.get(randomIdx) || 0
        const card = this.indexMap.get(randomIdx)
        const maxAmount = card?.maxAmount || 4
        if (currentCount < maxAmount) {
          deckIndices.push(randomIdx)
          cardCounts.set(randomIdx, currentCount + 1)
        }
      }
    } else if (strategy === 'rule_broken') {
      const inks = ['Amber', 'Amethyst', 'Emerald', 'Ruby', 'Sapphire', 'Steel']
      const chosenInks = []
      const inkCount = Math.random() < 0.5 ? 1 : 2
      for (let i = 0; i < inkCount; i++) {
        const ink = inks[Math.floor(Math.random() * inks.length)]
        if (!chosenInks.includes(ink)) chosenInks.push(ink)
      }
      const cardPool = []
      for (const [idx, card] of this.indexMap.entries()) {
        if (chosenInks.includes(card.ink)) {
          cardPool.push(idx)
        }
      }
      const costs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
      const cardCounts = new Map()
      for (let i = 0; i < deckSize; i++) {
        const targetCost = costs[Math.floor(Math.random() * costs.length)]
        const cardsOfCost = cardPool.filter((idx) => {
          const card = this.indexMap.get(idx)
          return card && card.cost === targetCost
        })
        if (cardsOfCost.length > 0) {
          let attempts = 0
          let picked = false
          while (!picked && attempts < 10) {
            const randomIdx = cardsOfCost[Math.floor(Math.random() * cardsOfCost.length)]
            const currentCount = cardCounts.get(randomIdx) || 0
            const card = this.indexMap.get(randomIdx)
            const maxAmount = card?.maxAmount || 4
            const shouldAddCopy = currentCount === 0 || (Math.random() < 0.3 && currentCount < maxAmount)
            if (shouldAddCopy && currentCount < maxAmount) {
              deckIndices.push(randomIdx)
              cardCounts.set(randomIdx, currentCount + 1)
              picked = true
            }
            attempts++
          }
        }
      }
      while (deckIndices.length < deckSize) {
        const randomIdx = cardPool[Math.floor(Math.random() * cardPool.length)]
        deckIndices.push(randomIdx)
      }
    } else if (strategy === 'low_diversity') {
      const cardPool = Array.from(this.cardMap.values())
      const numUniqueCards = Math.floor(Math.random() * 5) + 1
      const selectedCards = []
      while (selectedCards.length < numUniqueCards) {
        const randomIdx = cardPool[Math.floor(Math.random() * cardPool.length)]
        if (!selectedCards.includes(randomIdx)) selectedCards.push(randomIdx)
      }
      for (let i = 0; i < deckSize; i++) {
        const randomCard = selectedCards[Math.floor(Math.random() * selectedCards.length)]
        deckIndices.push(randomCard)
      }
    } else if (strategy === 'imbalanced_splash') {
      const inks = ['Amber', 'Amethyst', 'Emerald', 'Ruby', 'Sapphire', 'Steel']
      const inkA = inks[Math.floor(Math.random() * inks.length)]
      let inkB = inks[Math.floor(Math.random() * inks.length)]
      while (inkB === inkA) inkB = inks[Math.floor(Math.random() * inks.length)]
      const poolA = []
      const poolB = []
      for (const [idx, card] of this.indexMap.entries()) {
        if (card.ink === inkA) poolA.push(idx)
        if (card.ink === inkB) poolB.push(idx)
      }
      if (poolA.length > 0 && poolB.length > 0) {
        for (let i = 0; i < 55; i++) {
          const randomIdx = poolA[Math.floor(Math.random() * poolA.length)]
          deckIndices.push(randomIdx)
        }
        for (let i = 0; i < 5; i++) {
          const randomIdx = poolB[Math.floor(Math.random() * poolB.length)]
          deckIndices.push(randomIdx)
        }
      } else {
        return this.generateFakeDeck('pure_random')
      }
    }
    return deckIndices.slice(0, deckSize)
  }

  /**
   * Generate a synthetic deck for specific ink combination(s)
   * @param {string[]} inks - Array of ink colors (e.g., ['ruby', 'sapphire'] or ['amber'])
   * @returns {Object} Deck object with inks and cards array
   */
  generateSyntheticDeckForInks(inks) {
    const deckSize = 60
    const deckIndices = []
    const cardCounts = new Map()

    // Normalize ink names to match card data (capitalize first letter)
    const normalizedInks = inks.map(ink =>
      ink.charAt(0).toUpperCase() + ink.slice(1).toLowerCase()
    )

    // Build card pool for these inks
    const cardPool = []
    for (const [idx, card] of this.indexMap.entries()) {
      if (normalizedInks.includes(card.ink) && card.legality === 'legal') {
        cardPool.push(idx)
      }
    }

    if (cardPool.length === 0) {
      this.log(`Warning: No legal cards found for inks: ${inks.join(', ')}`)
      return null
    }

    // Generate deck with proper copy limits
    let attempts = 0
    const maxAttempts = 500
    while (deckIndices.length < deckSize && attempts < maxAttempts) {
      const randomIdx = cardPool[Math.floor(Math.random() * cardPool.length)]
      const currentCount = cardCounts.get(randomIdx) || 0
      const card = this.indexMap.get(randomIdx)
      const maxAmount = card?.maxAmount || 4

      if (currentCount < maxAmount) {
        deckIndices.push(randomIdx)
        cardCounts.set(randomIdx, currentCount + 1)
      }
      attempts++
    }

    // Convert to deck format
    const cardMap = new Map()
    for (const idx of deckIndices) {
      const card = this.indexMap.get(idx)
      const key = this.getCardKey(card.name, card.version)
      if (!cardMap.has(key)) {
        cardMap.set(key, { name: card.name, version: card.version, amount: 0 })
      }
      cardMap.get(key).amount++
    }

    return {
      inks: inks,
      cards: Array.from(cardMap.values()),
      synthetic: true
    }
  }

  /**
   * Create a variation of an existing deck by removing some cards and completing with random ones
   * @param {Object} deck - Existing deck object with inks and cards
   * @param {number} removalPercent - Percentage of cards to remove (0-1)
   * @returns {Object} Augmented deck object
   */
  augmentDeckWithVariation(deck, removalPercent = 0.2) {
    // Convert deck to indices
    const deckIndices = []
    for (const cardEntry of deck.cards) {
      const key = this.getCardKey(cardEntry.name, cardEntry.version)
      if (this.cardMap.has(key)) {
        const index = this.cardMap.get(key)
        for (let i = 0; i < cardEntry.amount; i++) {
          deckIndices.push(index)
        }
      }
    }

    if (deckIndices.length === 0) return null

    // Remove random cards
    const cardsToRemove = Math.floor(deckIndices.length * removalPercent)
    const remainingIndices = [...deckIndices]
    for (let i = 0; i < cardsToRemove; i++) {
      const removeIdx = Math.floor(Math.random() * remainingIndices.length)
      remainingIndices.splice(removeIdx, 1)
    }

    // Normalize ink names
    const normalizedInks = (deck.inks || []).map(ink =>
      ink.charAt(0).toUpperCase() + ink.slice(1).toLowerCase()
    )

    // Build card pool for completion
    const cardPool = []
    for (const [idx, card] of this.indexMap.entries()) {
      if (normalizedInks.includes(card.ink) && card.legality === 'legal') {
        cardPool.push(idx)
      }
    }

    if (cardPool.length === 0) return null

    // Complete the deck
    const cardCounts = new Map()
    for (const idx of remainingIndices) {
      cardCounts.set(idx, (cardCounts.get(idx) || 0) + 1)
    }

    const targetSize = 60
    let attempts = 0
    const maxAttempts = 200
    while (remainingIndices.length < targetSize && attempts < maxAttempts) {
      const randomIdx = cardPool[Math.floor(Math.random() * cardPool.length)]
      const currentCount = cardCounts.get(randomIdx) || 0
      const card = this.indexMap.get(randomIdx)
      const maxAmount = card?.maxAmount || 4

      if (currentCount < maxAmount) {
        remainingIndices.push(randomIdx)
        cardCounts.set(randomIdx, currentCount + 1)
      }
      attempts++
    }

    // Convert back to deck format
    const cardMap = new Map()
    for (const idx of remainingIndices) {
      const card = this.indexMap.get(idx)
      const key = this.getCardKey(card.name, card.version)
      if (!cardMap.has(key)) {
        cardMap.set(key, { name: card.name, version: card.version, amount: 0 })
      }
      cardMap.get(key).amount++
    }

    return {
      inks: deck.inks,
      cards: Array.from(cardMap.values()),
      synthetic: true,
      augmentedFrom: deck.hash
    }
  }

  generatePartialDeck(baseDeckIndices) {
    const cardsToRemove = Math.floor(Math.random() * 11) + 10
    const deckCopy = [...baseDeckIndices]
    for (let i = 0; i < cardsToRemove; i++) {
      const randomIndex = Math.floor(Math.random() * deckCopy.length)
      deckCopy.splice(randomIndex, 1)
    }
    return deckCopy
  }

  completePartialDeckWithGenerator(partialDeckIndices) {
    const deck = [...partialDeckIndices]
    const targetSize = 60
    const cardCounts = new Map()
    const inks = new Set()
    const costCounts = Array(10).fill(0)

    for (const idx of deck) {
      cardCounts.set(idx, (cardCounts.get(idx) || 0) + 1)
      const card = this.indexMap.get(idx)
      if (card) {
        if (card.ink) inks.add(card.ink)
        const costIdx = Math.min(card.cost - 1, 9)
        costCounts[costIdx]++
      }
    }

    const inkArray = Array.from(inks)
    const cardPool = []
    for (const [idx, card] of this.indexMap.entries()) {
      if (inkArray.includes(card.ink) && card.legality === 'legal') {
        cardPool.push(idx)
      }
    }
    if (cardPool.length === 0) {
      for (const idx of this.cardMap.values()) {
        cardPool.push(idx)
      }
    }

    let attempts = 0
    const maxAttempts = 200
    while (deck.length < targetSize && attempts < maxAttempts) {
      const targetCost = Math.floor(Math.random() * 4) + 2
      const cardsOfCost = cardPool.filter((idx) => {
        const card = this.indexMap.get(idx)
        return card && card.cost === targetCost
      })
      if (cardsOfCost.length > 0) {
        const randomIdx = cardsOfCost[Math.floor(Math.random() * cardsOfCost.length)]
        const currentCount = cardCounts.get(randomIdx) || 0
        const card = this.indexMap.get(randomIdx)
        const maxAmount = card?.maxAmount || 4
        if (currentCount < maxAmount) {
          deck.push(randomIdx)
          cardCounts.set(randomIdx, currentCount + 1)
          const costIdx = Math.min(card.cost - 1, 9)
          costCounts[costIdx]++
        }
      } else {
        const randomIdx = cardPool[Math.floor(Math.random() * cardPool.length)]
        const currentCount = cardCounts.get(randomIdx) || 0
        const card = this.indexMap.get(randomIdx)
        const maxAmount = card?.maxAmount || 4
        if (currentCount < maxAmount) {
          deck.push(randomIdx)
          cardCounts.set(randomIdx, currentCount + 1)
        }
      }
      attempts++
    }
    while (deck.length < targetSize) {
      const randomIdx = cardPool[Math.floor(Math.random() * cardPool.length)]
      deck.push(randomIdx)
    }
    return deck.slice(0, 60)
  }

  prepareValidationDataset() {
    this.log('Preparing validation dataset...')
    const features = []
    const labels = []
    let realDeckCount = 0
    const realDeckIndices = []

    // MODIFIED: Iterate this.newDecksToTrain OR load historical decks if needed?
    // For validation, we need diverse real decks. If newDecksToTrain is small, validation might be weak.
    // However, loading ALL hashes just for validation is expensive.
    // We will use newDecksToTrain if available, otherwise validation might be skipped or small.
    // Ideally we should keep a "validation set" separate, but for now we just use what we have.
    // If training incrementally, we validate on new data + maybe some baked-in validation set?
    // Current logic: uses this.trainingData.
    // We no longer populate this.trainingData with tournament objects.
    // We populate this.newDecksToTrain.

    // We need to resolve what to use here.
    const sourceDecks = this.newDecksToTrain

    for (const deck of sourceDecks) {
      const deckIndices = []
      for (const cardEntry of deck.cards) {
        const key = this.getCardKey(cardEntry.name, cardEntry.version)
        if (this.cardMap.has(key)) {
          const index = this.cardMap.get(key)
          for (let i = 0; i < cardEntry.amount; i++) {
            deckIndices.push(index)
          }
        }
      }
      if (deckIndices.length >= 60) {
        const fullDeck = deckIndices.slice(0, 60)
        const deckFeatures = this.extractDeckFeaturesWithEmbeddings(fullDeck)
        features.push(deckFeatures)
        let score = 0.85
        if (deck.place) {
          score = Math.max(0.6, 1.0 - (deck.place - 1) * 0.02)
        }
        labels.push(score)
        realDeckCount++
        realDeckIndices.push(fullDeck)
      }
    }

    this.log(`Extracted ${realDeckCount} real decks`)

    let partialDeckCount = 0
    for (const baseDeck of realDeckIndices) {
      const numVariants = Math.random() < 0.5 ? 1 : 2
      for (let v = 0; v < numVariants; v++) {
        const partialDeck = this.generatePartialDeck(baseDeck)
        const completedDeck = this.completePartialDeckWithGenerator(partialDeck)
        const deckFeatures = this.extractDeckFeaturesWithEmbeddings(completedDeck)
        features.push(deckFeatures)
        labels.push(0.6)
        partialDeckCount++
      }
    }

    this.log(`Generated ${partialDeckCount} partial decks (medium quality)`)

    const strategyCounts = {
      pure_random: Math.floor(realDeckCount * 0.25),
      ink_constrained: Math.floor(realDeckCount * 0.2),
      rule_broken: Math.floor(realDeckCount * 0.2),
      low_diversity: Math.floor(realDeckCount * 0.15),
      imbalanced_splash: Math.floor(realDeckCount * 0.2)
    }

    for (const [strategy, count] of Object.entries(strategyCounts)) {
      for (let i = 0; i < count; i++) {
        const fakeDeck = this.generateFakeDeck(strategy)
        const deckFeatures = this.extractDeckFeaturesWithEmbeddings(fakeDeck.slice(0, 60))
        features.push(deckFeatures)
        labels.push(0)
      }
    }

    this.log(`Generated ${realDeckCount} fake decks`)
    this.log(`Total dataset size: ${features.length} decks`)
    if (features.length > 0) {
      this.log(`Feature dimension: ${features[0].length}`)
    }

    return { features, labels }
  }

  /**
   * Fisher-Yates (Knuth) shuffle algorithm - unbiased random shuffle
   * @param {Array} array - Array to shuffle
   * @returns {Array} New shuffled array
   */
  fisherYatesShuffle (array) {
    const shuffled = [...array]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    return shuffled
  }
}
