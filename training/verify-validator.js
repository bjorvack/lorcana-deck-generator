/**
 * Verify Validator Script
 * Tests the trained validator model on tournament decks
 * Outputs accuracy metrics and deck validation results
 */
const TrainingManager = require('./src/TrainingManager')
const ValidationModel = require('./src/ValidationModel')

const fs = require('fs')
const path = require('path')

async function verifyValidator() {
  console.log('='.repeat(60))
  console.log('🔍 VALIDATOR VERIFICATION')
  console.log('='.repeat(60))
  console.log('')

  const manager = new TrainingManager()
  const validator = new ValidationModel()

  // 1. Load cards
  console.log('📦 Loading cards...')
  manager.cards = await manager.cardApi.getCards()
  console.log(`   Loaded ${manager.cards.length} cards`)

  // Build card maps
  manager.cards.forEach((card) => {
    const key = manager.getCardKey(card.name, card.version)
    if (!manager.cardMap.has(key)) {
      const id = manager.cardMap.size
      manager.cardMap.set(key, id)
      manager.indexMap.set(id, card)
    }
  })
  console.log(`   Indexed ${manager.cardMap.size} unique cards`)

  // 2. Build embeddings
  console.log('\n🔢 Computing embeddings...')
  manager.textEmbedder.buildVocabulary(manager.cards)
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
  console.log('   Embeddings computed')

  // 3. Load validator model
  console.log('\n📥 Loading validator model...')
  const modelPath = path.join(__dirname, '..', 'training_data', 'deck-validator-model')
  
  if (!fs.existsSync(path.join(modelPath, 'model.json'))) {
    console.error('❌ Validator model not found!')
    console.error(`   Path: ${modelPath}`)
    console.error('   Run: npm run train -- --train-validator')
    process.exit(1)
  }
  
  await validator.initialize(manager.textEmbedder.vocabularySize, 38)
  await validator.loadModel(modelPath)
  console.log('   Model loaded')

  // 4. Load decks for testing
  console.log('\n📂 Loading test decks...')
  manager.loadTrainingState()
  if (!manager.trainingState.trainedDeckHashes) {
    manager.trainingState.trainedDeckHashes = []
  }
  manager.deckHashSet = new Set(manager.trainingState.trainedDeckHashes)
  
  await manager.loadTrainingData(true)
  console.log(`   Loaded ${manager.newDecksToTrain.length} decks`)

  // 5. Run validation tests
  console.log('\n' + '='.repeat(60))
  console.log('🧪 TESTING VALIDATOR')
  console.log('='.repeat(60))

  let realDecksCorrect = 0
  let totalRealDecks = 0
  let fakeDecksCorrect = 0
  let totalFakeDecks = 0

  const results = {
    real: [],
    fake: []
  }

  // Test on real tournament decks
  console.log('\n📊 Testing on real tournament decks...')
  const sampleRealDecks = manager.newDecksToTrain.slice(0, 500)
  
  for (const deck of sampleRealDecks) {
    const deckIndices = []
    for (const cardEntry of deck.cards) {
      const key = manager.getCardKey(cardEntry.name, cardEntry.version)
      if (manager.cardMap.has(key)) {
        const index = manager.cardMap.get(key)
        for (let i = 0; i < cardEntry.amount; i++) {
          deckIndices.push(index)
        }
      }
    }
    
    if (deckIndices.length >= 60) {
      const fullDeck = deckIndices.slice(0, 60)
      const deckFeatures = manager.extractDeckFeaturesWithEmbeddings(fullDeck)
      
      const result = await validator.evaluate(deckFeatures)
      
      if (result >= 0.8) {
        realDecksCorrect++
      }
      totalRealDecks++
      
      results.real.push({ score: result, valid: result >= 0.8 })
    }
  }

  // Test on fake decks
  console.log('📊 Testing on fake decks...')
  const fakeStrategies = ['pure_random', 'ink_constrained', 'low_diversity', 'excessive_singletons', 'too_many_actions']
  
  for (const strategy of fakeStrategies) {
    for (let i = 0; i < 100; i++) {
      const fakeDeck = manager.generateFakeDeck(strategy)
      const deckFeatures = manager.extractDeckFeaturesWithEmbeddings(fakeDeck.slice(0, 60))
      
      const result = await validator.evaluate(deckFeatures)
      
      if (result < 0.8) {
        fakeDecksCorrect++
      }
      totalFakeDecks++
      
      results.fake.push({ score: result, valid: result >= 0.8, strategy })
    }
  }

  // 6. Output results
  console.log('\n' + '='.repeat(60))
  console.log('📈 VALIDATOR RESULTS')
  console.log('='.repeat(60))

  const realAccuracy = totalRealDecks > 0 ? (realDecksCorrect / totalRealDecks) * 100 : 0
  const fakeAccuracy = totalFakeDecks > 0 ? (fakeDecksCorrect / totalFakeDecks) * 100 : 0
  
  console.log(`\n   Real Tournament Decks (n=${totalRealDecks}):`)
  console.log(`   ✓ Validated as real: ${realDecksCorrect}/${totalRealDecks} (${realAccuracy.toFixed(1)}%)`)
  
  console.log(`\n   Generated Fake Decks (n=${totalFakeDecks}):`)
  console.log(`   ✓ Rejected as fake: ${fakeDecksCorrect}/${totalFakeDecks} (${fakeAccuracy.toFixed(1)}%)`)

  // Score distribution
  const realScores = results.real.map(r => r.score)
  const fakeScores = results.fake.map(r => r.score)
  
  console.log(`\n   Score Distribution:`)
  console.log(`   Real decks: min=${Math.min(...realScores).toFixed(2)}, max=${Math.max(...realScores).toFixed(2)}, avg=${(realScores.reduce((a,b) => a+b,0)/realScores.length).toFixed(2)}`)
  console.log(`   Fake decks: min=${Math.min(...fakeScores).toFixed(2)}, max=${Math.max(...fakeScores).toFixed(2)}, avg=${(fakeScores.reduce((a,b) => a+b,0)/fakeScores.length).toFixed(2)}`)

  // Overall assessment
  console.log('\n' + '-'.repeat(60))
  if (realAccuracy >= 90 && fakeAccuracy >= 80) {
    console.log('✅ VALIDATOR: Excellent performance!')
  } else if (realAccuracy >= 80 && fakeAccuracy >= 70) {
    console.log('⚠️ VALIDATOR: Good performance, but could be improved')
  } else {
    console.log('❌ VALIDATOR: Needs more training')
  }
  console.log('-'.repeat(60))
  console.log('')
}

verifyValidator().catch(error => {
  console.error('Verification failed:', error)
  process.exit(1)
})
