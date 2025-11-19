import * as tf from '@tensorflow/tfjs';

export default class DeckModel {
    constructor() {
        this.model = null;
        this.vocabSize = 0;
        this.featureDim = 0;
        this.maxLen = 60; // Max deck size usually 60
        this.embeddingDim = 32;
        this.lstmUnits = 64;
    }

    initialize(vocabSize, featureDim) {
        this.vocabSize = vocabSize + 1; // +1 for padding/OOV
        this.featureDim = featureDim;

        // Define Inputs
        const inputIndices = tf.input({ shape: [this.maxLen], name: 'input_indices' });
        const inputFeatures = tf.input({ shape: [this.maxLen, this.featureDim], name: 'input_features' });

        // Embedding Layer for Indices
        const embedding = tf.layers.embedding({
            inputDim: this.vocabSize,
            outputDim: this.embeddingDim,
            inputLength: this.maxLen,
            maskZero: true,
            name: 'embedding'
        }).apply(inputIndices);

        // Concatenate Embedding and Features
        const concatenated = tf.layers.concatenate().apply([embedding, inputFeatures]);

        // LSTM Layer
        const lstm = tf.layers.lstm({
            units: this.lstmUnits,
            returnSequences: false,
            name: 'lstm'
        }).apply(concatenated);

        // Output Layer
        const output = tf.layers.dense({
            units: this.vocabSize,
            activation: 'softmax',
            name: 'output'
        }).apply(lstm);

        // Create Model
        this.model = tf.model({ inputs: [inputIndices, inputFeatures], outputs: output });

        this.model.compile({
            optimizer: 'adam',
            loss: 'sparseCategoricalCrossentropy',
            metrics: ['accuracy']
        });

        this.model.summary();
    }

    async train(sequences, featureSequences, epochs, onEpochEnd) {
        if (!this.model) {
            throw new Error("Model not initialized");
        }

        const { xsIndices, xsFeatures, ys } = this.prepareData(sequences, featureSequences);

        // Early stopping: stop if validation loss doesn't improve for 3 epochs
        let bestValLoss = Infinity;
        let patienceCounter = 0;
        const patience = 3;

        await this.model.fit([xsIndices, xsFeatures], ys, {
            epochs: epochs || 10,
            batchSize: 64, // Increased from 32 for faster training
            validationSplit: 0.1,
            callbacks: {
                onEpochEnd: (epoch, logs) => {
                    if (onEpochEnd) onEpochEnd(epoch, logs);

                    // Early stopping logic
                    if (logs.val_loss < bestValLoss) {
                        bestValLoss = logs.val_loss;
                        patienceCounter = 0;
                    } else {
                        patienceCounter++;
                        if (patienceCounter >= patience) {
                            console.log(`Early stopping at epoch ${epoch + 1}`);
                            this.model.stopTraining = true;
                        }
                    }
                }
            }
        });

        xsIndices.dispose();
        xsFeatures.dispose();
        ys.dispose();
    }

    prepareData(sequences, featureSequences) {
        const xsIndices = [];
        const xsFeatures = [];
        const ys = [];

        sequences.forEach((seq, seqIdx) => {
            const featSeq = featureSequences[seqIdx];

            // Limit max examples per deck to avoid browser hang
            const step = Math.max(1, Math.floor(seq.length / 10));

            for (let i = 1; i < seq.length; i += step) {
                const inputSeqIndices = seq.slice(0, i);
                const inputSeqFeatures = featSeq.slice(0, i);
                const target = seq[i];

                // Pad input sequence indices
                const paddedIndices = Array(this.maxLen).fill(0);
                const startIdx = Math.max(0, this.maxLen - inputSeqIndices.length);
                for (let j = 0; j < Math.min(inputSeqIndices.length, this.maxLen); j++) {
                    paddedIndices[startIdx + j] = inputSeqIndices[j];
                }

                // Pad input sequence features
                // Feature padding should be 0 vectors
                const paddedFeatures = [];
                for (let k = 0; k < this.maxLen; k++) {
                    paddedFeatures.push(Array(this.featureDim).fill(0));
                }

                for (let j = 0; j < Math.min(inputSeqFeatures.length, this.maxLen); j++) {
                    paddedFeatures[startIdx + j] = inputSeqFeatures[j];
                }

                xsIndices.push(paddedIndices);
                xsFeatures.push(paddedFeatures);
                ys.push(target);
            }
        });

        return {
            xsIndices: tf.tensor2d(xsIndices, [xsIndices.length, this.maxLen]),
            xsFeatures: tf.tensor3d(xsFeatures, [xsFeatures.length, this.maxLen, this.featureDim]),
            ys: tf.tensor1d(ys)
        };
    }

    async predict(cardIndices, cardFeatures) {
        if (!this.model) return null;

        // Prepare input indices
        const paddedIndices = Array(this.maxLen).fill(0);
        const startIdx = Math.max(0, this.maxLen - cardIndices.length);
        for (let j = 0; j < Math.min(cardIndices.length, this.maxLen); j++) {
            paddedIndices[startIdx + j] = cardIndices[j];
        }

        // Prepare input features
        const paddedFeatures = [];
        for (let k = 0; k < this.maxLen; k++) {
            paddedFeatures.push(Array(this.featureDim).fill(0));
        }
        for (let j = 0; j < Math.min(cardFeatures.length, this.maxLen); j++) {
            paddedFeatures[startIdx + j] = cardFeatures[j];
        }

        const inputIndicesTensor = tf.tensor2d([paddedIndices], [1, this.maxLen]);
        const inputFeaturesTensor = tf.tensor3d([paddedFeatures], [1, this.maxLen, this.featureDim]);

        const prediction = this.model.predict([inputIndicesTensor, inputFeaturesTensor]);

        // Get probabilities
        const probabilities = await prediction.data();

        inputIndicesTensor.dispose();
        inputFeaturesTensor.dispose();
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
        // Recover featureDim from model input shape
        // model.inputs[1].shape is [null, 60, featureDim]
        if (this.model.inputs && this.model.inputs.length > 1) {
            this.featureDim = this.model.inputs[1].shape[2];
        }
        this.model.summary();
    }
}
