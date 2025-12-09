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
    console.log('Regularization: L2=0.001, Dropout=0.3\n')

    const featuresTensor = tf.tensor2d(features)
    const labelsTensor = tf.tensor2d(labels.map(l => [l]))

    // Split train/val
    const splitIdx = Math.floor(labels.length * 0.8)

    // Learning rate scheduler: reduce LR when validation loss plateaus
    let bestValLoss = Infinity
    let patienceCounter = 0
    const patience = 5
    let currentLR = 0.003

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
            // Format metrics nicely
            const metrics = [
                            `loss=${logs.loss.toFixed(4)}`,
                            `acc=${(logs.acc * 100).toFixed(1)}%`,
                            `val_loss=${logs.val_loss.toFixed(4)}`,
                            `val_acc=${(logs.val_acc * 100).toFixed(1)}%`
            ]
            console.log(`Epoch ${epoch + 1}/${epochs}: ${metrics.join(', ')}`)

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

            // Early stopping if accuracy is very high
            if (logs.val_acc >= 0.95 && logs.val_loss < 0.2) {
              console.log(`   ✓ Early stopping: validation accuracy ${(logs.val_acc * 100).toFixed(1)}% achieved!`)
              this.model.stopTraining = true
            }
          }
        }
      }
    )

    featuresTensor.dispose()
    labelsTensor.dispose()

    console.log('\n✅ Training complete!')
    console.log(`Final metrics: loss=${history.history.loss[history.history.loss.length - 1].toFixed(4)}, ` +
            `val_loss=${history.history.val_loss[history.history.val_loss.length - 1].toFixed(4)}, ` +
            `val_acc=${(history.history.val_acc[history.history.val_acc.length - 1] * 100).toFixed(1)}%`)
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
    if (requestedInks.length === 2) {
      // We need to reconstruct ink counts from features or pass raw deck
      // Since features are aggregated, we can't easily get exact ink counts here without changing input
      // However, we can check if the model predicts it as "bad" based on training data
      // But for immediate rule-based penalty (since we can't easily retrain model right now with ink features):
      
      // NOTE: Ideally, we should pass the raw deck to evaluate() or add ink ratios to features.
      // Assuming we can't change feature structure easily, we rely on the neural network
      // to have learned that "imbalanced" decks are bad (via training data).
      
      // But we can add a heuristic penalty if we had access to ink counts.
    }

    // Otherwise, use neural network prediction
    const featuresTensor = tf.tensor2d([features])
    const prediction = this.model.predict(featuresTensor)
    const score = await prediction.data()
    featuresTensor.dispose()
    prediction.dispose()
    return score[0]
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
