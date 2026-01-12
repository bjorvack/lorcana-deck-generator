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

        // Create shuffled versions
        for (let k = 0; k < totalRepetitions; k++) {
          const shuffledIndices = [...deckIndices].sort(
            () => Math.random() - 0.5
          )

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

      // Generate all possible ink combinations
      const INKS = ['amber', 'amethyst', 'emerald', 'ruby', 'sapphire', 'steel']
      const allCombinations = []
      // Single ink
      for (const ink of INKS) {
        allCombinations.push([ink])
      }
      // Two-ink
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
}
