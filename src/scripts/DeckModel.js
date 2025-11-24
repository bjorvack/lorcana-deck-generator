import * as tf from '@tensorflow/tfjs';

export default class DeckModel {
    constructor() {
        this.model = null;
        this.vocabSize = 0;
        this.maxLen = 60; // Max deck size usually 60
        this.embeddingDim = 64; // Dimension of the card embedding
        this.lstmUnits = 128; // Increased units for better state tracking
    }

    async loadModel(modelPath) {
        this.model = await tf.loadLayersModel(modelPath);
        // Infer vocab size from embedding layer input dim
        const embeddingLayer = this.model.getLayer('card_embedding');
        this.vocabSize = embeddingLayer.inputDim;
        this.embeddingDim = embeddingLayer.outputDim;
        console.log(`Model loaded. Vocab: ${this.vocabSize}, Embedding: ${this.embeddingDim}`);
    }

    async predict(indices) {
        if (!this.model) {
            throw new Error('Model not loaded');
        }

        // Pad sequence to maxLen
        const paddedIndices = new Array(this.maxLen).fill(0);
        // Fill from the end or start? Usually start for LSTM.
        // Let's assume left-padded or right-padded?
        // TrainingManager uses standard array, likely right-padded if length < 60?
        // Actually, TrainingManager slices sequences.
        // Let's just fill the available slots.
        for (let i = 0; i < Math.min(indices.length, this.maxLen); i++) {
            paddedIndices[i] = indices[i];
        }

        const inputTensor = tf.tensor2d([paddedIndices], [1, this.maxLen], 'int32');

        const prediction = this.model.predict(inputTensor);
        const probabilities = await prediction.data();

        inputTensor.dispose();
        prediction.dispose();

        return probabilities;
    }

    async train(sequences, featureSequences, textSequences, epochs, onEpochEnd) {
        // Frontend training is not typically used, but keeping signature consistent
        console.warn("Training in frontend is not fully implemented/optimized.");
    }

    prepareData(sequences, featureSequences) {
        return {};
    }

    async predict(cardIndices) {
        if (!this.model) return null;

        // Prepare input features
        const startIdx = Math.max(0, this.maxLen - cardIndices.length);

        // Pad Sequence
        const paddedSeq = new Array(this.maxLen).fill(0);
        for (let j = 0; j < Math.min(cardIndices.length, this.maxLen); j++) {
            paddedSeq[startIdx + j] = cardIndices[j];
        }

        const inputTensor = tf.tensor2d([paddedSeq], [1, this.maxLen], 'int32');
        const prediction = this.model.predict(inputTensor);
        const probabilities = await prediction.data();

        inputTensor.dispose();
        prediction.dispose();

        return probabilities;
    }

    async saveModel(path) {
        if (!this.model) return;
        if (!path.startsWith('file://')) {
            path = `file://${path}`;
        }
        await this.model.save(path);
    }

    async loadModel(path) {
        // Ensure path starts with file:// (for browser this might be http://... but let's assume local for now or handle appropriately)
        // In browser, tf.loadLayersModel usually takes a URL.
        this.model = await tf.loadLayersModel(path);
        this.model.compile({
            optimizer: 'adam',
            loss: 'sparseCategoricalCrossentropy',
            metrics: ['accuracy']
        });

        // Recover dimensions from model input shape
        if (this.model.inputs && this.model.inputs.length > 0) {
            this.featureDim = this.model.inputs[0].shape[2];
        }
        if (this.model.inputs && this.model.inputs.length > 1) {
            this.maxNameTokens = this.model.inputs[1].shape[2];
        }
        if (this.model.inputs && this.model.inputs.length > 2) {
            this.maxKeywordsTokens = this.model.inputs[2].shape[2];
        }
        if (this.model.inputs && this.model.inputs.length > 3) {
            this.maxInkTokens = this.model.inputs[3].shape[2];
        }
        if (this.model.inputs && this.model.inputs.length > 4) {
            this.maxClassTokens = this.model.inputs[4].shape[2];
        }
        if (this.model.inputs && this.model.inputs.length > 5) {
            this.maxTypeTokens = this.model.inputs[5].shape[2];
        }
        if (this.model.inputs && this.model.inputs.length > 6) {
            this.maxBodyTokens = this.model.inputs[6].shape[2];
        }
        this.model.summary();
    }
}
