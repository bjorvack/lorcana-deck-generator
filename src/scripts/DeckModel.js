import * as tf from '@tensorflow/tfjs'

export default class DeckModel {
  constructor () {
    this.model = null
    this.vocabSize = 0
    this.maxLen = 60 // Max deck size usually 60
    this.embeddingDim = 64 // Dimension of the card embedding
    this.lstmUnits = 128 // Increased units for better state tracking
  }

  async loadModel (modelPath) {
    this.model = await tf.loadLayersModel(modelPath)
    // Infer vocab size from embedding layer input dim
    const embeddingLayer = this.model.getLayer('card_embedding')
    this.vocabSize = embeddingLayer.inputDim
    this.embeddingDim = embeddingLayer.outputDim
    console.log(`Model loaded. Vocab: ${this.vocabSize}, Embedding: ${this.embeddingDim}`)
  }

  async predict (cardIndices) {
    if (!this.model) return null

    // Prepare input features
    // Match training padding: Right-aligned (zeros at start)
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
}
