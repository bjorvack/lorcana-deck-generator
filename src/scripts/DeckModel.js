import * as tf from '@tensorflow/tfjs';

export default class DeckModel {
    constructor() {
        this.model = null;
        this.vocabSize = 0;
        this.maxLen = 60; // Max deck size usually 60
        this.embeddingDim = 32;
        this.lstmUnits = 64;
    }

    initialize(vocabSize) {
        this.vocabSize = vocabSize + 1; // +1 for padding/OOV

        this.model = tf.sequential();

        // Embedding Layer
        this.model.add(tf.layers.embedding({
            inputDim: this.vocabSize,
            outputDim: this.embeddingDim,
            inputLength: this.maxLen,
            maskZero: true
        }));

        // LSTM Layer
        this.model.add(tf.layers.lstm({
            units: this.lstmUnits,
            returnSequences: false
        }));

        // Output Layer
        this.model.add(tf.layers.dense({
            units: this.vocabSize,
            activation: 'softmax'
        }));

        this.model.compile({
            optimizer: 'adam',
            loss: 'sparseCategoricalCrossentropy',
            metrics: ['accuracy']
        });

        this.model.summary();
    }

    async train(sequences, epochs, onEpochEnd) {
        if (!this.model) {
            throw new Error("Model not initialized");
        }

        const { xs, ys } = this.prepareData(sequences);

        await this.model.fit(xs, ys, {
            epochs: epochs || 10,
            batchSize: 32,
            validationSplit: 0.1,
            callbacks: {
                onEpochEnd: (epoch, logs) => {
                    if (onEpochEnd) onEpochEnd(epoch, logs);
                }
            }
        });

        xs.dispose();
        ys.dispose();
    }

    prepareData(sequences) {
        const xs = [];
        const ys = [];

        sequences.forEach(seq => {
            // Generate sliding windows
            // For a deck of 60 cards, we can generate 59 examples?
            // Or just a few.
            // Let's generate a few examples per sequence to avoid exploding data size.
            // Or since we shuffled, maybe just take the whole sequence up to N and predict N+1?
            // Let's do: for i from 1 to len-1
            // Input: seq[0...i-1], Output: seq[i]

            // Limit max examples per deck to avoid browser hang
            const step = Math.max(1, Math.floor(seq.length / 10));

            for (let i = 1; i < seq.length; i += step) {
                const inputSeq = seq.slice(0, i);
                const target = seq[i];

                // Pad input sequence
                const paddedInput = Array(this.maxLen).fill(0);
                // Fill from the end or beginning? Usually end for RNNs if we want recent context.
                // But masking handles it. Let's fill from end (pre-padding) is standard for some, post-padding for others.
                // TFJS embedding with maskZero supports variable length effectively.
                // Let's do post-padding (fill start, rest 0) or pre-padding.
                // Pre-padding is often better for LSTMs so the relevant info is at the end.
                const startIdx = Math.max(0, this.maxLen - inputSeq.length);
                for (let j = 0; j < Math.min(inputSeq.length, this.maxLen); j++) {
                    paddedInput[startIdx + j] = inputSeq[j];
                }

                xs.push(paddedInput);
                ys.push(target);
            }
        });

        return {
            xs: tf.tensor2d(xs, [xs.length, this.maxLen]),
            ys: tf.tensor1d(ys) // Sparse categorical expects integer targets
        };
    }

    async predict(cardIndices) {
        if (!this.model) return null;

        // Prepare input
        const paddedInput = Array(this.maxLen).fill(0);
        const startIdx = Math.max(0, this.maxLen - cardIndices.length);
        for (let j = 0; j < Math.min(cardIndices.length, this.maxLen); j++) {
            paddedInput[startIdx + j] = cardIndices[j];
        }

        const inputTensor = tf.tensor2d([paddedInput], [1, this.maxLen]);
        const prediction = this.model.predict(inputTensor);

        // Get probabilities
        const probabilities = await prediction.data();

        inputTensor.dispose();
        prediction.dispose();

        return probabilities;
    }

    async saveModel(path) {
        if (!this.model) return;
        await this.model.save(path);
    }

    async loadModel(path) {
        this.model = await tf.loadLayersModel(path);
        // Recompile model after loading to ensure it's ready for training/prediction
        this.model.compile({
            optimizer: 'adam',
            loss: 'sparseCategoricalCrossentropy',
            metrics: ['accuracy']
        });
        this.model.summary();
    }
}
