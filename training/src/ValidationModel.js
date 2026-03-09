const tf = require('@tensorflow/tfjs-node')

/**
 * Validation Model - Set-based binary classifier
 * Aggregates embeddings across entire deck (order-independent)
 * to learn card co-occurrence patterns
 */
module.exports = class ValidationModel {
  constructor () {
    this.model = null
    this.embeddingDim = 32
  }

  async initialize (textVocabSize, numericFeatureDim) {
    this.textVocabSize = textVocabSize
    this.numericFeatureDim = numericFeatureDim

    console.log('\n=== Validation Model Architecture ===')
    console.log(`Text vocabulary size: ${this.textVocabSize}`)
    console.log(`Numeric feature dimension: ${this.numericFeatureDim}`)
    console.log(`Embedding dimension: ${this.embeddingDim}`)

    // Input: deck-level aggregated features
    // This will include:
    // - Mean/max/var of text embeddings across deck
    // - Statistical features (mana curve, type dist, etc.)
    const inputDim = this.numericFeatureDim + (this.embeddingDim * 3) // mean + max + variance

    const input = tf.input({
      shape: [inputDim],
      dtype: 'float32',
      name: 'deck_features'
    })

    // Dense layers with L2 regularization
    // Increased model capacity to address underfitting
    let x = tf.layers.dense({
      units: 256, // Increased from 128
      activation: 'relu',
      kernelRegularizer: tf.regularizers.l2({ l2: 0.001 }), // Reduced from 0.01
      name: 'dense_1'
    }).apply(input)

    x = tf.layers.dropout({
      rate: 0.3, // Reduced from 0.5 (was too aggressive)
      name: 'dropout_1'
    }).apply(x)

    x = tf.layers.dense({
      units: 128, // Increased from 64
      activation: 'relu',
      kernelRegularizer: tf.regularizers.l2({ l2: 0.001 }), // Reduced from 0.01
      name: 'dense_2'
    }).apply(x)

    x = tf.layers.dropout({
      rate: 0.3, // Reduced from 0.5
      name: 'dropout_2'
    }).apply(x)

    x = tf.layers.dense({
      units: 64, // Increased from 32
      activation: 'relu',
      kernelRegularizer: tf.regularizers.l2({ l2: 0.001 }), // Reduced from 0.01
      name: 'dense_3'
    }).apply(x)

    x = tf.layers.dropout({
      rate: 0.3,
      name: 'dropout_3'
    }).apply(x)

    x = tf.layers.dense({
      units: 32,
      activation: 'relu',
      kernelRegularizer: tf.regularizers.l2({ l2: 0.001 }),
      name: 'dense_4'
    }).apply(x)

    const output = tf.layers.dense({
      units: 1,
      activation: 'sigmoid',
      name: 'output'
    }).apply(x)

    this.model = tf.model({
      inputs: input,
      outputs: output,
      name: 'validation_model'
    })

    // Increased learning rate from 0.001 to 0.003 (3x) to address slow convergence
    this.model.compile({
      optimizer: tf.train.adam(0.003), // Increased from 0.001
      loss: 'binaryCrossentropy',
      metrics: ['accuracy'] // TensorFlow.js doesn't have built-in precision/recall
    })

    this.model.summary()
  }

  async train (features, labels, epochs = 20) {
    console.log('\nTraining validation model...')
    console.log(`Training on ${labels.length} decks...`)
    console.log('Architecture: 256 → 128 → 64 → 32 → 1')
    console.log('Learning rate: 0.003 (3x increased)')
    console.log('Regularization: L2=0.001, Dropout=0.3')
    console.log('Target: 90% of real decks validated as valid\n')

    const featuresTensor = tf.tensor2d(features)
    const labelsTensor = tf.tensor2d(labels.map(l => [l]))

    // Split train/val
    const splitIdx = Math.floor(labels.length * 0.8)
    
    const valFeatures = features.slice(splitIdx)
    const valLabels = labels.slice(splitIdx)

    // Learning rate scheduler: reduce LR when validation loss plateaus
    let bestValLoss = Infinity
    let patienceCounter = 0
    const patience = 5
    let currentLR = 0.003
    let targetAchieved = false

    // Calculate real deck validation rate (percentage of real decks predicted as valid)
    const calculateRealDeckAccuracy = (predictions, labels) => {
      let realDecksCorrect = 0
      let totalRealDecks = 0
      
      for (let i = 0; i < labels.length; i++) {
        // Real decks have label > 0
        if (labels[i] > 0) {
          totalRealDecks++
          // Consider valid if predicted score >= 0.8 (stricter threshold)
          if (predictions[i] >= 0.8) {
            realDecksCorrect++
          }
        }
      }
      
      return totalRealDecks > 0 ? (realDecksCorrect / totalRealDecks) : 0
    }

    const history = await this.model.fit(
      featuresTensor.slice([0, 0], [splitIdx, features[0].length]),
      labelsTensor.slice([0, 0], [splitIdx, 1]),
      {
        epochs,
        batchSize: 32,
        validationData: [
          featuresTensor.slice([splitIdx, 0], [labels.length - splitIdx, features[0].length]),
          labelsTensor.slice([splitIdx, 0], [labels.length - splitIdx, 1])
        ],
        callbacks: {
          onEpochEnd: async (epoch, logs) => {
            // Get predictions on validation set
            const valPredTensor = this.model.predict(
              tf.tensor2d(valFeatures)
            )
            const valPreds = await valPredTensor.data()
            valPredTensor.dispose()
            
            // Calculate real deck validation rate
            const realDeckAccuracy = calculateRealDeckAccuracy(valPreds, valLabels)
            const fakeDeckAccuracy = calculateRealDeckAccuracy(
              valPreds.map(p => 1 - p), 
              valLabels.map(l => l === 0 ? 1 : 0)
            )

            // Calculate average scores for real and fake decks
            let realDeckSum = 0
            let realDeckCount = 0
            let fakeDeckSum = 0
            let fakeDeckCount = 0
            
            for (let i = 0; i < valLabels.length; i++) {
              if (valLabels[i] > 0) {
                realDeckSum += valPreds[i]
                realDeckCount++
              } else {
                fakeDeckSum += valPreds[i]
                fakeDeckCount++
              }
            }
            
            const avgRealDeckScore = realDeckCount > 0 ? realDeckSum / realDeckCount : 0
            const avgFakeDeckScore = fakeDeckCount > 0 ? fakeDeckSum / fakeDeckCount : 0
            
            // Format metrics nicely
            const metrics = [
              `loss=${logs.loss.toFixed(4)}`,
              `acc=${(logs.acc * 100).toFixed(1)}%`,
              `real=${(avgRealDeckScore * 100).toFixed(1)}%`,
              `fake=${(avgFakeDeckScore * 100).toFixed(1)}%`,
              `val_loss=${logs.val_loss.toFixed(4)}`
            ]
            console.log(`Epoch ${epoch + 1}/${epochs}: ${metrics.join(', ')}`)

            // Check if 90% of real decks are validated as valid
            if (realDeckAccuracy >= 0.90) {
              console.log(`   ✓ Target achieved: ${(realDeckAccuracy * 100).toFixed(1)}% of real decks validated (target: 90%)`)
              targetAchieved = true
              // Don't stop immediately - try to improve further
              if (realDeckAccuracy >= 0.95) {
                console.log(`   ✓ Excellent: ${(realDeckAccuracy * 100).toFixed(1)}% - stopping`)
                this.model.stopTraining = true
              }
            }

            // Learning rate scheduling
            if (logs.val_loss < bestValLoss) {
              bestValLoss = logs.val_loss
              patienceCounter = 0
            } else {
              patienceCounter++
              if (patienceCounter >= patience && currentLR > 0.0001) {
                currentLR *= 0.5
                console.log(`   → Reducing learning rate to ${currentLR.toFixed(6)}`)
                // Update optimizer learning rate
                this.model.optimizer.learningRate = currentLR
                patienceCounter = 0
              }
            }
          }
        }
      }
    )

    featuresTensor.dispose()
    labelsTensor.dispose()

    // Calculate final metrics on validation set
    const valPredTensor = this.model.predict(tf.tensor2d(valFeatures))
    const valPreds = await valPredTensor.data()
    valPredTensor.dispose()

    const finalRealDeckRate = calculateRealDeckAccuracy(valPreds, valLabels)
    const finalFakeDeckRate = calculateRealDeckAccuracy(
      valPreds.map(p => 1 - p),
      valLabels.map(l => l === 0 ? 1 : 0)
    )
    const finalAcc = history.history.val_acc[history.history.val_acc.length - 1]

    // Calculate average scores for real and fake decks
    let realDeckSum = 0
    let realDeckCount = 0
    let fakeDeckSum = 0
    let fakeDeckCount = 0
    
    for (let i = 0; i < valLabels.length; i++) {
      if (valLabels[i] > 0) {
        realDeckSum += valPreds[i]
        realDeckCount++
      } else {
        fakeDeckSum += valPreds[i]
        fakeDeckCount++
      }
    }
    
    const avgRealDeckScore = realDeckCount > 0 ? realDeckSum / realDeckCount : 0
    const avgFakeDeckScore = fakeDeckCount > 0 ? fakeDeckSum / fakeDeckCount : 0

    console.log('\n' + '='.repeat(50))
    console.log('📊 VALIDATOR TRAINING OVERVIEW')
    console.log('='.repeat(50))
    console.log(`Total training samples: ${labels.length}`)
    console.log(`  - Real decks: ${labels.filter(l => l > 0).length}`)
    console.log(`  - Fake decks: ${labels.filter(l => l === 0).length}`)
    console.log('')
    console.log(`Final Results (validation set):`)
    console.log(`  - Real decks validated (>= 0.8): ${(finalRealDeckRate * 100).toFixed(1)}%`)
    console.log(`  - Fake decks rejected (< 0.8): ${(finalFakeDeckRate * 100).toFixed(1)}%`)
    console.log(`  - Overall accuracy: ${(finalAcc * 100).toFixed(1)}%`)
    console.log('')
    console.log(`Average Scores (before training = 0.5 baseline):`)
    console.log(`  - Real decks avg score: ${(avgRealDeckScore * 100).toFixed(1)}%`)
    console.log(`  - Fake decks avg score: ${(avgFakeDeckScore * 100).toFixed(1)}%`)
    console.log('')
    
    if (finalRealDeckRate >= 0.90) {
      console.log('✅ Target achieved: 90% of real decks validated!')
    } else {
      console.log(`⚠️ Target not met: ${(finalRealDeckRate * 100).toFixed(1)}% (target: 90%)`)
      console.log('   Consider training for more epochs.')
    }
    console.log('='.repeat(50))
    
    return history
  }

  async evaluate (features, requestedInks = []) {
    // First, check for explicit rule-based failures
    const uniqueCardDiversity = features[0] // First feature is unique card count / 20
    const estimatedUniqueCards = Math.round(uniqueCardDiversity * 20)

    // Hard rule: if fewer than 10 unique cards, immediately fail
    if (estimatedUniqueCards < 10) {
      console.log(`[RULE] Low diversity detected: ${estimatedUniqueCards} unique cards - returning 0.0`)
      return 0.0 // Override neural network - this is clearly fake
    }

    // Check for ink balance if requestedInks provided
    // Ink counts are at positions 13-18 (after cost: 0-9, types: 10-12)
    const inkFeatureStart = 13
    const inkNames = ['Amber', 'Amethyst', 'Emerald', 'Ruby', 'Sapphire', 'Steel']
    const inkCounts = {}
    for (let i = 0; i < 6; i++) {
      inkCounts[inkNames[i]] = features[inkFeatureStart + i]
    }

    // Get singleton ratio (feature index 1)
    const singletonRatio = features[1]
    
    // Get uninkable ratio (feature index 26)
    const uninkableRatio = features[26] || 0

    if (requestedInks && requestedInks.length > 0) {
      const totalCards = features.reduce((sum, f) => sum + f, 0) // Approximate total
      const inkableCards = features[12] // inkable ratio
      const totalInkable = Math.round(inkableCards * 60)

      // RULE: Check singleton ratio - too many singletons is unrealistic
      if (singletonRatio > 0.35) {
        console.log(`[RULE] Excessive singletons: ${Math.round(singletonRatio * 100)}% - returning 0.0`)
        return 0.0 // Too many singletons = unrealistic deck
      }

      // RULE: Check uninkable ratio - too many uninkable cards
      if (uninkableRatio > 0.4) {
        console.log(`[RULE] Excessive uninkable cards: ${Math.round(uninkableRatio * 100)}% - returning 0.0`)
        return 0.0 // Can't play the deck
      }

      // Check that at least 3 cards can produce each ink
      const minCardsPerInk = 3
      for (const requestedInk of requestedInks) {
        const inkCount = inkCounts[requestedInk] || 0
        if (inkCount * 60 < minCardsPerInk) {
          console.log(`[RULE] Insufficient ${requestedInk} ink: ${Math.round(inkCount * 60)} cards - applying penalty`)
          // Return neural network score but with significant penalty
          const featuresTensor = tf.tensor2d([features])
          const prediction = this.model.predict(featuresTensor)
          const score = (await prediction.data())[0]
          featuresTensor.dispose()
          prediction.dispose()
          return Math.max(0, score - 0.3) // Penalize by 30%
        }
      }

      // For dual-ink decks, check for reasonable balance (not too lopsided)
      if (requestedInks.length === 2) {
        const ink1Count = inkCounts[requestedInks[0]] || 0
        const ink2Count = inkCounts[requestedInks[1]] || 0
        const ratio = Math.min(ink1Count, ink2Count) / Math.max(ink1Count, ink2Count + 0.001)

        // If one ink is more than 4x the other, it's likely imbalanced
        if (ratio < 0.25 && ink1Count > 0.1 && ink2Count > 0.1) {
          console.log(`[RULE] Imbalanced dual-ink detected: ratio ${ratio.toFixed(2)} - applying penalty`)
          const featuresTensor = tf.tensor2d([features])
          const prediction = this.model.predict(featuresTensor)
          const score = (await prediction.data())[0]
          featuresTensor.dispose()
          prediction.dispose()
          return Math.max(0, score - 0.2) // Penalize by 20%
        }
      }
    }

    // Otherwise, use neural network prediction
    const featuresTensor = tf.tensor2d([features])
    const prediction = this.model.predict(featuresTensor)
    const score = (await prediction.data())[0]
    featuresTensor.dispose()
    prediction.dispose()
    
    // Apply penalties for moderate singleton/uninkable issues (soft rules)
    let finalScore = score
    if (singletonRatio > 0.25) {
      finalScore = Math.max(0, finalScore - 0.15) // 15% penalty for 25-35% singletons
    }
    if (uninkableRatio > 0.25) {
      finalScore = Math.max(0, finalScore - 0.15) // 15% penalty for 25-40% uninkable
    }
    
    return finalScore
  }

  async evaluateWithBreakdown (features, requestedInks = []) {
    const score = await this.evaluate(features, requestedInks)
    const grade = this.getGrade(score)
    const message = this.getMessage(score)

    // Analyze features for breakdown
    const breakdown = this.analyzeFeatures(features, requestedInks)

    return { score, grade, message, breakdown }
  }

  analyzeFeatures (features, requestedInks = []) {
    // Features are: [numeric features (38), mean embeddings (32), max embeddings (32), variance embeddings (32)]
    const numericStart = 0
    const numericEnd = this.numericFeatureDim
    const varStart = numericEnd + (this.embeddingDim * 2)

    const numericFeatures = features.slice(numericStart, numericEnd)
    const embeddingVariance = features.slice(varStart, varStart + this.embeddingDim)

    const issues = []

    // Check unique card diversity (feature 0)
    const uniqueCardDiversity = numericFeatures[0]
    const estimatedUniqueCards = Math.round(uniqueCardDiversity * 20)
    if (estimatedUniqueCards < 10) {
      issues.push({
        issue: 'Very low card diversity',
        severity: 'high',
        message: `Only ~${estimatedUniqueCards} unique cards (expected 15-20)`
      })
    }

    // Check embedding variance (low variance = repetitive cards)
    const avgVariance = embeddingVariance.reduce((a, b) => a + b, 0) / embeddingVariance.length
    if (avgVariance < 0.01) {
      issues.push({
        issue: 'Repetitive card patterns',
        severity: 'high',
        message: 'Cards are too similar (detected via semantic analysis)'
      })
    }

    // Check singleton ratio
    const singletonRatio = numericFeatures[1]
    if (singletonRatio > 0.3) {
      issues.push({
        issue: 'High singleton count',
        severity: 'high',
        message: `${Math.round(singletonRatio * 100)}% of unique cards have only 1 copy`
      })
    }

    // Check inkable ratio (warn only if < 50%)
    const inkableRatio = numericFeatures[26]
    if (inkableRatio < 0.5) {
      issues.push({
        issue: 'Low inkable ratio',
        severity: 'medium',
        message: `Only ${Math.round(inkableRatio * 100)}% inkable cards (recommended at least 50%)`
      })
    }

    return issues
  }

  getGrade (score) {
    if (score >= 0.85) return 'A'
    if (score >= 0.70) return 'B'
    if (score >= 0.50) return 'C'
    return 'D'
  }

  getMessage (score) {
    if (score >= 0.85) return 'This deck looks authentic!'
    if (score >= 0.70) return 'This deck looks realistic with minor issues'
    if (score >= 0.50) return 'This deck has some unrealistic patterns'
    return 'This deck seems randomly generated'
  }

  async saveModel (path) {
    await this.model.save(`file://${path}`)
    console.log(`Validation model saved to ${path}`)
  }

  async loadModel (path) {
    this.model = await tf.loadLayersModel(`file://${path}/model.json`)
    console.log(`Validation model loaded from ${path}`)
  }
}
