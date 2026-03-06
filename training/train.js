const TrainingManager = require('./src/TrainingManager');
const ValidationModel = require('./src/ValidationModel');

(async () => {
  try {
    const manager = new TrainingManager()

    // Parse command line arguments
    const args = process.argv.slice(2)
    let epochs = 20
    let fullRetrain = false
    let continueTraining = false
    let balanceClasses = true
    let trainValidator = false

    for (const arg of args) {
      if (arg === '--full') {
        fullRetrain = true
      } else if (arg === '--continue') {
        continueTraining = true
      } else if (arg === '--no-balance') {
        balanceClasses = false
      } else if (arg === '--train-validator') {
        trainValidator = true
      } else if (!isNaN(parseInt(arg))) {
        epochs = parseInt(arg)
      }
    }

    console.log('='.repeat(50))
    console.log('Lorcana Deck Generator - Training')
    console.log('='.repeat(50))
    console.log(`Epochs: ${epochs}`)
    console.log(`Mode: ${fullRetrain ? 'Full Retrain' : continueTraining ? 'Continue Training' : 'Incremental Training'}`)
    console.log(`Class Balancing: ${balanceClasses ? 'Enabled' : 'Disabled'}`)
    console.log(`Train Validator: ${trainValidator ? 'Yes' : 'No'}`)
    console.log('='.repeat(50))
    console.log('')

    // Optional: Train validator first
    if (trainValidator) {
      console.log('=== Training Validator First ===\n')
      
      // Setup validator
      const validator = new ValidationModel()
      
      // Fetch cards
      console.log('Fetching cards...')
      manager.cards = await manager.cardApi.getCards()
      console.log(`Fetched ${manager.cards.length} cards.`)
      
      // Build card maps
      manager.cards.forEach((card) => {
        const key = manager.getCardKey(card.name, card.version)
        if (!manager.cardMap.has(key)) {
          const id = manager.cardMap.size
          manager.cardMap.set(key, id)
          manager.indexMap.set(id, card)
        }
      })
      console.log(`Unique cards indexed: ${manager.cardMap.size}`)
      
      // Build text vocabulary
      console.log('Building text vocabulary...')
      manager.textEmbedder.buildVocabulary(manager.cards)
      console.log(`Vocabulary size: ${manager.textEmbedder.vocabularySize}`)
      
      // Compute TF-IDF embeddings
      console.log('Computing TF-IDF embeddings...')
      const embeddingDim = 32
      const documentFrequency = new Array(manager.textEmbedder.vocabularySize).fill(0)
      const totalDocs = manager.indexMap.size
      
      for (const [, card] of manager.indexMap.entries()) {
        const textIndices = manager.textEmbedder.cardToTextIndices(card)
        const uniqueTokens = new Set([
          ...textIndices.name, ...textIndices.keywords, ...textIndices.ink,
          ...textIndices.classifications, ...textIndices.types, ...textIndices.text
        ])
        for (const tokenIdx of uniqueTokens) {
          if (tokenIdx > 0) documentFrequency[tokenIdx]++
        }
      }
      
      const idf = documentFrequency.map((df, idx) => {
        if (idx === 0 || df === 0) return 0
        return Math.log(totalDocs / df)
      })
      
      for (const [, card] of manager.indexMap.entries()) {
        const textIndices = manager.textEmbedder.cardToTextIndices(card)
        const allTokens = [
          ...textIndices.name, ...textIndices.keywords, ...textIndices.ink,
          ...textIndices.classifications, ...textIndices.types, ...textIndices.text
        ]
        const termFrequency = new Array(manager.textEmbedder.vocabularySize).fill(0)
        for (const tokenIdx of allTokens) {
          if (tokenIdx > 0) termFrequency[tokenIdx]++
        }
        const tfidfVector = termFrequency.map((tf, i) => tf * idf[i])
        const embedding = new Array(embeddingDim).fill(0)
        for (let i = 0; i < tfidfVector.length; i++) {
          embedding[i % embeddingDim] += tfidfVector[i]
        }
        const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0))
        if (norm > 0) {
          for (let i = 0; i < embeddingDim; i++) {
            embedding[i] /= norm
          }
        }
        card.embedding = embedding
      }
      
      // Load decks for training - force load ALL decks (not just new ones)
      // This ensures validator learns from the full historical dataset
      manager.loadTrainingState()
      if (!manager.trainingState.trainedDeckHashes) {
        manager.trainingState.trainedDeckHashes = []
      }
      
      // For validator training, we need to load ALL decks, not skip trained ones
      // Temporarily clear deckHashSet so loadTrainingData loads everything
      const savedDeckHashSet = manager.deckHashSet
      manager.deckHashSet = new Set() // Clear to load ALL decks
      
      await manager.loadTrainingData(true) // forceLoadAll=true
      console.log(`Loaded ${manager.newDecksToTrain.length} decks for validator training (ALL decks)`)
      
      // Prepare dataset - pass false to use ALL loaded decks
      const { features, labels } = manager.prepareValidationDataset()
      console.log(`Dataset: ${features.length} samples, ${labels.filter(l => l > 0).length} positive, ${labels.filter(l => l === 0).length} negative`)
      
      // Restore deckHashSet for normal training
      manager.deckHashSet = savedDeckHashSet
      
      // Train validator
      await validator.initialize(manager.textEmbedder.vocabularySize, 38)
      await validator.train(features, labels, epochs)
      
      // Save validator
      const fs = require('fs')
      const path = require('path')
      const savePath = path.join(__dirname, '..', 'training_data', 'deck-validator-model')
      await validator.saveModel(savePath)
      console.log('Validator model saved!')
      
      console.log('\n=== Validator Training Complete ===\n')
    }

    await manager.startTraining(epochs, fullRetrain, continueTraining, balanceClasses)
  } catch (error) {
    console.error('Training failed:', error)
    process.exit(1)
  }
})()
