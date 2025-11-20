const tf = require('@tensorflow/tfjs-node');

module.exports = class DeckModel {
    constructor() {
        this.model = null;
        this.vocabSize = 0;
        this.featureDim = 0;
        this.maxLen = 60; // Max deck size usually 60
        this.embeddingDim = 32;
        this.lstmUnits = 64;
        this.textVocabSize = 0; // NEW: text vocabulary size
        this.maxTextTokens = 0; // NEW: max text tokens per card
        this.textEmbeddingDim = 16; // NEW: text embedding dimension
    }

    async initialize(vocabSize, featureDim, textVocabSize, maxTextTokens) {
        // --- Save model parameters ---
        this.vocabSize = vocabSize + 1; // +1 for padding / OOV token
        this.featureDim = featureDim;
        this.textVocabSize = textVocabSize; // NEW
        this.maxTextTokens = maxTextTokens; // NEW

        // --- Define Inputs ---
        // inputIndices: sequence of card IDs
        const inputIndices = tf.input({
            shape: [this.maxLen],
            dtype: 'int32',
            name: 'input_indices'
        });

        // inputFeatures: precomputed numeric features for each card in the sequence
        const inputFeatures = tf.input({
            shape: [this.maxLen, this.featureDim],
            dtype: 'float32',
            name: 'input_features'
        });

        // inputTextTokens: text tokens for each card in the sequence (NEW)
        const inputTextTokens = tf.input({
            shape: [this.maxLen, this.maxTextTokens],
            dtype: 'int32',
            name: 'input_text_tokens'
        });

        // --- Embedding Layer for card indices ---
        const embedding = tf.layers.embedding({
            inputDim: this.vocabSize,
            outputDim: this.embeddingDim,
            inputLength: this.maxLen,
            // maskZero: true, // Removed to avoid "gradient function not found for All" error
            name: 'embedding'
        }).apply(inputIndices);

        // --- Text Embedding Layer (NEW) ---
        // For each card in sequence, we have maxTextTokens  
        // We need to reshape to process all tokens at once
        const textEmbedding = tf.layers.embedding({
            inputDim: this.textVocabSize,
            outputDim: this.textEmbeddingDim,
            name: 'text_embedding'
        }).apply(inputTextTokens); // Shape: [batch, maxLen, maxTextTokens, textEmbeddingDim]

        // Simplify: Flatten the text embeddings per card and project down
        // Instead of TimeDistributed(GlobalAveragePooling1D) which caused gradient issues

        // Reshape to [batch, maxLen, maxTextTokens * textEmbeddingDim]
        const textFlattener = tf.layers.reshape({
            targetShape: [this.maxLen, this.maxTextTokens * this.textEmbeddingDim],
            name: 'text_flatten'
        }).apply(textEmbedding);

        // Project back to textEmbeddingDim using a Dense layer
        // Dense applied to rank 3 tensor acts on the last dimension (features), shared across steps
        const textProjection = tf.layers.dense({
            units: this.textEmbeddingDim,
            activation: 'relu',
            name: 'text_projection'
        }).apply(textFlattener); // Shape: [batch, maxLen, textEmbeddingDim]

        // --- Concatenate card embedding + numeric features + text embeddings ---
        const concatenated = tf.layers.concatenate({
            name: 'concat_all_features'
        }).apply([embedding, inputFeatures, textProjection]);

        // --- LSTM Layer ---
        const lstm = tf.layers.lstm({
            units: this.lstmUnits,
            returnSequences: false,
            name: 'lstm'
        }).apply(concatenated);

        // --- Output Layer: predict next card ---
        const output = tf.layers.dense({
            units: this.vocabSize,
            activation: 'softmax',
            name: 'output'
        }).apply(lstm);

        // --- Create the model ---
        this.model = tf.model({
            inputs: [inputIndices, inputFeatures, inputTextTokens],
            outputs: output,
            name: 'deck_predictor'
        });

        // --- Compile the model ---
        this.model.compile({
            optimizer: tf.train.adam(0.001),  // default learning rate, can be customized
            loss: 'sparseCategoricalCrossentropy',
            metrics: ['accuracy']
        });

        // --- Print summary for verification ---
        this.model.summary();
    }


    async train(sequences, featureSequences, textSequences, epochs, onEpochEnd) {
        if (!this.model) {
            throw new Error("Model not initialized");
        }

        const { xsIndices, xsFeatures, xsTextTokens, ys } = this.prepareData(sequences, featureSequences, textSequences);

        // Early stopping: stop if validation loss doesn't improve for 3 epochs
        let bestValLoss = Infinity;
        let patienceCounter = 0;
        const patience = 3;

        await this.model.fit([xsIndices, xsFeatures, xsTextTokens], ys, {
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
        xsTextTokens.dispose();
        ys.dispose();
    }

    prepareData(sequences, featureSequences, textSequences) {
        const xsIndices = [];
        const xsFeatures = [];
        const xsTextTokens = []; // NEW
        const ys = [];

        sequences.forEach((seq, seqIdx) => {
            const featSeq = featureSequences[seqIdx];
            const textSeq = textSequences[seqIdx]; // NEW

            // Limit max examples per deck to avoid browser hang - NOT NEEDED IN NODE but kept for consistency/speed
            const step = Math.max(1, Math.floor(seq.length / 10));

            for (let i = 1; i < seq.length; i += step) {
                const inputSeqIndices = seq.slice(0, i);
                const inputSeqFeatures = featSeq.slice(0, i);
                const inputSeqTextTokens = textSeq.slice(0, i); // NEW
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

                // Pad input sequence text tokens (NEW)
                const paddedTextTokens = [];
                for (let k = 0; k < this.maxLen; k++) {
                    paddedTextTokens.push(Array(this.maxTextTokens).fill(0)); // Pad with token 0
                }

                for (let j = 0; j < Math.min(inputSeqTextTokens.length, this.maxLen); j++) {
                    paddedTextTokens[startIdx + j] = inputSeqTextTokens[j];
                }

                xsIndices.push(paddedIndices);
                xsFeatures.push(paddedFeatures);
                xsTextTokens.push(paddedTextTokens); // NEW
                ys.push(target);
            }
        });

        return {
            xsIndices: tf.tensor2d(xsIndices, [xsIndices.length, this.maxLen]),
            xsFeatures: tf.tensor3d(xsFeatures, [xsFeatures.length, this.maxLen, this.featureDim]),
            xsTextTokens: tf.tensor3d(xsTextTokens, [xsTextTokens.length, this.maxLen, this.maxTextTokens]), // NEW
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
        // Ensure path starts with file://
        if (!path.startsWith('file://')) {
            path = `file://${path}`;
        }
        await this.model.save(path);
    }

    async loadModel(path) {
        // Ensure path starts with file://
        if (!path.startsWith('file://')) {
            path = `file://${path}`;
        }
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
