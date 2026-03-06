const tf = require('@tensorflow/tfjs-node')

module.exports = class DeckModel {
  constructor () {
    this.model = null
    this.vocabSize = 0
    this.maxLen = 60 // Max deck size usually 60
    this.embeddingDim = 128 // Increased from 64
    this.lstmUnits = 256 // Increased from 128
  }

  async initialize (vocabSize, embeddingMatrix) {
    // --- Save model parameters ---
    this.vocabSize = vocabSize + 1 // +1 for padding / OOV token

    // --- Define Inputs ---
    // 1. Card IDs (Sequence of integers)
    const inputCardIds = tf.input({
      shape: [this.maxLen],
      dtype: 'int32',
      name: 'input_card_ids'
    })

    // --- Embedding Layer ---
    // Initialize with pre-computed card features
    // We add a row of zeros for the padding/OOV token at index 0
    // embeddingMatrix should be shape [vocabSize, embeddingDim]

    // Create full weights including padding token (index 0)
    // The passed embeddingMatrix corresponds to indices 1..vocabSize
    const padRow = tf.zeros([1, embeddingMatrix[0].length])
    const weightsTensor = tf.tensor(embeddingMatrix)
    const fullWeights = tf.concat([padRow, weightsTensor], 0)

    this.embeddingDim = fullWeights.shape[1]

    const embeddingLayer = tf.layers.embedding({
      inputDim: this.vocabSize,
      outputDim: this.embeddingDim,
      weights: [fullWeights],
      trainable: true, // Allow fine-tuning
      name: 'card_embedding'
    })

    const embedded = embeddingLayer.apply(inputCardIds)

    // --- LSTM Layers ---
    // Layer 1: Return sequences for next layer
    const lstm1 = tf.layers.lstm({
      units: this.lstmUnits,
      returnSequences: true,
      name: 'lstm_1'
    }).apply(embedded)

    // Layer 2: Final state
    const lstm2 = tf.layers.lstm({
      units: this.lstmUnits, // Keep same size
      returnSequences: false,
      name: 'lstm_2'
    }).apply(lstm1)

    // --- Output Layer: predict next card ---
    const output = tf.layers.dense({
      units: this.vocabSize,
      activation: 'softmax',
      name: 'output'
    }).apply(lstm2)

    // --- Create the model ---
    this.model = tf.model({
      inputs: inputCardIds,
      outputs: output,
      name: 'deck_predictor'
    })

    // --- Compile the model ---
    this.model.compile({
      optimizer: tf.train.adam(0.001),
      loss: 'categoricalCrossentropy',
      metrics: ['accuracy']
    })

    // --- Print summary for verification ---
    this.model.summary()
  }

  async train (sequences, epochs, onEpochEnd) {
    if (!this.model) {
      throw new Error('Model not initialized')
    }

    const { xs, ys } = this.prepareData(sequences)

    // Early stopping: stop if validation loss doesn't improve for 3 epochs
    let bestValLoss = Infinity
    let patienceCounter = 0
    const patience = 3

    await this.model.fit(
      xs,
      ys,
      {
        epochs: epochs || 10,
        batchSize: 256, // Increased from 64 for faster CPU training
        validationSplit: 0.1,
        callbacks: {
          onEpochEnd: (epoch, logs) => {
            if (onEpochEnd) onEpochEnd(epoch, logs)

            // Early stopping logic
            if (logs.val_loss < bestValLoss) {
              bestValLoss = logs.val_loss
              patienceCounter = 0
            } else {
              patienceCounter++
              if (patienceCounter >= patience) {
                console.log(`Early stopping at epoch ${epoch + 1}`)
                this.model.stopTraining = true
              }
            }
          }
        }
      }
    )

    xs.dispose()
    ys.dispose()
  }

  prepareData (sequences) {
    const xs = []
    const ys = []

    sequences.forEach((seq) => {
      // Limit max examples per deck to avoid overfitting on specific sequences
      // and to speed up training.
      const step = Math.max(1, Math.floor(seq.length / 10))

      for (let i = 1; i < seq.length; i += step) {
        const inputSeqIndices = seq.slice(0, i)
        const target = seq[i]

        const startIdx = Math.max(0, this.maxLen - inputSeqIndices.length)

        // Pad Sequence
        const paddedSeq = new Array(this.maxLen).fill(0)
        for (let j = 0; j < Math.min(inputSeqIndices.length, this.maxLen); j++) {
          paddedSeq[startIdx + j] = inputSeqIndices[j]
        }

        xs.push(paddedSeq)
        ys.push(target)
      }
    })

    return {
      xs: tf.tensor2d(xs, [xs.length, this.maxLen], 'int32'),
      ys: tf.oneHot(tf.tensor1d(ys, 'int32'), this.vocabSize)
    }
  }

  async predict (cardIndices) {
    if (!this.model) return null

    // Prepare input features
    const startIdx = Math.max(0, this.maxLen - cardIndices.length)

    // Pad Sequence
    const paddedSeq = new Array(this.maxLen).fill(0)
    for (let j = 0; j < Math.min(cardIndices.length, this.maxLen); j++) {
      paddedSeq[startIdx + j] = cardIndices[j]
    }

    const inputTensor = tf.tensor2d([paddedSeq], [1, this.maxLen], 'int32')
    const prediction = this.model.predict(inputTensor)
    const probabilities = await prediction.data()

    inputTensor.dispose()
    prediction.dispose()

    return probabilities
  }

  /**
   * Predict next card with enhanced context for synergy awareness
   * This allows the model to learn card synergies based on current deck state
   * @param {Array} cardIndices - Current deck card indices
   * @param {Object} context - Additional context: { keywords: Set, inkCounts: Object, costCurve: Array }
   * @returns {Float32Array} Probability distribution over cards
   */
  async predictWithContext (cardIndices, context = {}) {
    if (!this.model) return null

    const startIdx = Math.max(0, this.maxLen - cardIndices.length)

    // Pad Sequence
    const paddedSeq = new Array(this.maxLen).fill(0)
    for (let j = 0; j < Math.min(cardIndices.length, this.maxLen); j++) {
      paddedSeq[startIdx + j] = cardIndices[j]
    }

    const inputTensor = tf.tensor2d([paddedSeq], [1, this.maxLen], 'int32')
    const prediction = this.model.predict(inputTensor)
    let probabilities = await prediction.data()

    // Apply context-aware adjustments if synergy matrices available
    if (context.synergyMatrix && cardIndices.length > 0) {
      probabilities = this.applySynergyBoost(probabilities, cardIndices, context)
    }

    inputTensor.dispose()
    prediction.dispose()

    return probabilities
  }

  /**
   * Apply synergy-based boost to card probabilities
   * @param {Float32Array} probs - Original probabilities
   * @param {Array} currentDeck - Current deck card indices
   * @param {Object} context - Context with synergy data
   * @returns {Float32Array} Adjusted probabilities
   */
  applySynergyBoost (probs, currentDeck, context) {
    const adjusted = new Float32Array(probs.length)

    for (let i = 0; i < probs.length; i++) {
      if (probs[i] === 0) {
        adjusted[i] = 0
        continue
      }

      let synergyBoost = 1.0

      // Boost cards that synergize with current deck
      if (context.synergyMatrix) {
        let totalSynergy = 0
        let count = 0

        for (const deckCardId of currentDeck) {
          const cardSynergies = context.synergyMatrix.get(deckCardId)
          if (cardSynergies) {
            const synergy = cardSynergies.get(i)
            if (synergy) {
              totalSynergy += synergy
              count++
            }
          }
        }

        if (count > 0) {
          // Boost by up to 50% based on synergy
          const avgSynergy = totalSynergy / count
          synergyBoost = 1.0 + (avgSynergy * 0.5)
        }
      }

      adjusted[i] = probs[i] * synergyBoost
    }

    // Renormalize
    const sum = adjusted.reduce((a, b) => a + b, 0)
    if (sum > 0) {
      for (let i = 0; i < adjusted.length; i++) {
        adjusted[i] /= sum
      }
    }

    return adjusted
  }

  async saveModel (path) {
    if (!this.model) return
    // Ensure path starts with file://
    if (!path.startsWith('file://')) {
      path = `file://${path}`
    }
    await this.model.save(path)
  }

  async loadModel (path) {
    // Ensure path starts with file://
    if (!path.startsWith('file://')) {
      path = `file://${path}`
    }
    this.model = await tf.loadLayersModel(path)

    // Infer vocabSize from output shape (needed for predictions)
    if (this.model.outputs && this.model.outputs.length > 0) {
      // Output shape is [null, vocabSize]
      this.vocabSize = this.model.outputs[0].shape[1]
    }

    // Recompile model after loading - use categoricalCrossentropy to match training
    // (Note: This is for inference. For RL training with integer labels, use sparseCategoricalCrossentropy)
    this.model.compile({
      optimizer: 'adam',
      loss: 'categoricalCrossentropy',
      metrics: ['accuracy']
    })

    // Recover dimensions from model input shape
    // model.inputs[0].shape is [null, 60, featureDim]
    if (this.model.inputs && this.model.inputs.length > 0) {
      this.featureDim = this.model.inputs[0].shape[2]
    }
    // model.inputs[1].shape is [null, 60, maxNameTokens]
    if (this.model.inputs && this.model.inputs.length > 1) {
      this.maxNameTokens = this.model.inputs[1].shape[2]
    }
    // model.inputs[2].shape is [null, 60, maxKeywordsTokens]
    if (this.model.inputs && this.model.inputs.length > 2) {
      this.maxKeywordsTokens = this.model.inputs[2].shape[2]
    }
    // model.inputs[3].shape is [null, 60, maxInkTokens]
    if (this.model.inputs && this.model.inputs.length > 3) {
      this.maxInkTokens = this.model.inputs[3].shape[2]
    }
    // model.inputs[4].shape is [null, 60, maxClassTokens]
    if (this.model.inputs && this.model.inputs.length > 4) {
      this.maxClassTokens = this.model.inputs[4].shape[2]
    }
    // model.inputs[5].shape is [null, 60, maxTypeTokens]
    if (this.model.inputs && this.model.inputs.length > 5) {
      this.maxTypeTokens = this.model.inputs[5].shape[2]
    }
    // model.inputs[6].shape is [null, 60, maxBodyTokens]
    if (this.model.inputs && this.model.inputs.length > 6) {
      this.maxBodyTokens = this.model.inputs[6].shape[2]
    }

    // Infer vocabSize from output shape
    if (this.model.outputs && this.model.outputs.length > 0) {
      // Output shape is [null, vocabSize]
      this.vocabSize = this.model.outputs[0].shape[1]
    }

    this.model.summary()
  }

  /**
     * RL-specific: Sample action from probability distribution
     * @param {Array|Float32Array} probabilities - Probability distribution over actions
     * @param {Number} temperature - Temperature for exploration (default 1.0)
     * @returns {Number} Sampled action index
     */
  sampleAction (probabilities, temperature = 1.0) {
    const probs = Array.from(probabilities)

    // Apply temperature scaling
    const scaled = probs.map(p => Math.pow(p, 1 / temperature))
    const sum = scaled.reduce((a, b) => a + b, 0)
    const normalized = scaled.map(p => p / sum)

    // Sample from categorical distribution
    const rand = Math.random()
    let cumsum = 0
    for (let i = 0; i < normalized.length; i++) {
      cumsum += normalized[i]
      if (rand < cumsum) {
        return i
      }
    }

    return normalized.length - 1
  }

  /**
     * RL-specific: Get log probability of action
     * @param {Array|Float32Array} probabilities - Probability distribution over actions
     * @param {Number} action - Action index
     * @returns {Number} Log probability
     */
  getLogProb (probabilities, action) {
    const probs = Array.from(probabilities)
    // Clip for numerical stability
    return Math.log(Math.max(probs[action], 1e-10))
  }

  /**
     * RL-specific: Predict with gradient tracking
     * Returns tensor for gradient computation
     * @param {Array} cardIndices - Current deck indices
     * @returns {Tensor} Probability distribution tensor
     */
  async predictWithGradient (cardIndices) {
    if (!this.model) return null

    const startIdx = Math.max(0, this.maxLen - cardIndices.length)
    const paddedSeq = new Array(this.maxLen).fill(0)
    for (let j = 0; j < Math.min(cardIndices.length, this.maxLen); j++) {
      paddedSeq[startIdx + j] = cardIndices[j]
    }

    const inputTensor = tf.tensor2d([paddedSeq], [1, this.maxLen], 'int32')

    // Use predict with explicit training=true to ensure gradient tracking
    const prediction = this.model.predict(inputTensor, { training: true })

    // Note: Caller is responsible for disposing the returned prediction tensor
    // Store inputTensor on prediction for later cleanup by caller
    prediction.inputTensor = inputTensor

    return prediction
  }

  /**
   * Dispose tensors from predictWithGradient
   * @param {Tensor} prediction - Prediction tensor from predictWithGradient
   */
  disposePrediction (prediction) {
    if (prediction) {
      if (prediction.inputTensor) {
        prediction.inputTensor.dispose()
      }
      prediction.dispose()
    }
  }
}
