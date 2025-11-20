import * as tf from '@tensorflow/tfjs';

export default class DeckModel {
    constructor() {
        this.model = null;
        this.vocabSize = 0;
        this.featureDim = 0;
        this.maxLen = 60; // Max deck size usually 60
        this.embeddingDim = 32;
        this.lstmUnits = 64;
        this.textVocabSize = 0; // NEW
        this.maxTextTokens = 0; // NEW
        this.textEmbeddingDim = 16; // NEW
    }

    async initialize(vocabSize, featureDim, textVocabSize, maxTextTokens) {
        // --- Save model parameters ---
        this.vocabSize = vocabSize + 1; // +1 for padding / OOV token
        this.featureDim = featureDim;
        this.textVocabSize = textVocabSize;
        this.maxTextTokens = maxTextTokens;

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
        const textEmbedding = tf.layers.embedding({
            inputDim: this.textVocabSize,
            outputDim: this.textEmbeddingDim,
            name: 'text_embedding'
        }).apply(inputTextTokens);

        // Simplify: Flatten the text embeddings per card and project down
        // Instead of TimeDistributed(GlobalAveragePooling1D) which caused gradient issues

        // Reshape to [batch, maxLen, maxTextTokens * textEmbeddingDim]
        const textFlattener = tf.layers.reshape({
            targetShape: [this.maxLen, this.maxTextTokens * this.textEmbeddingDim],
            name: 'text_flatten'
        }).apply(textEmbedding);

        // Project back to textEmbeddingDim using a Dense layer
        const textProjection = tf.layers.dense({
            units: this.textEmbeddingDim,
            activation: 'relu',
            name: 'text_projection'
        }).apply(textFlattener);

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


    async train(sequences, featureSequences, epochs, onEpochEnd) {
        // Browser training not primarily used, but keeping signature compatible if needed
        // For now, throwing error if text sequences not provided but model expects them
        console.warn("Browser training with text embeddings not fully implemented yet");
    }

    prepareData(sequences, featureSequences) {
        // Browser training data prep - skipping update for now as we train in Node
        return {};
    }

    async predict(cardIndices, cardFeatures, textIndices) {
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

        // Prepare input text tokens (NEW)
        // We need to know maxTextTokens. If not set (e.g. model loaded), try to infer or default
        if (!this.maxTextTokens && this.model.inputs[2]) {
            this.maxTextTokens = this.model.inputs[2].shape[2];
        }
        const maxTokens = this.maxTextTokens || 20; // Default fallback

        const paddedTextTokens = [];
        for (let k = 0; k < this.maxLen; k++) {
            paddedTextTokens.push(Array(maxTokens).fill(0));
        }

        if (textIndices) {
            for (let j = 0; j < Math.min(textIndices.length, this.maxLen); j++) {
                paddedTextTokens[startIdx + j] = textIndices[j];
            }
        }

        const inputIndicesTensor = tf.tensor2d([paddedIndices], [1, this.maxLen]);
        const inputFeaturesTensor = tf.tensor3d([paddedFeatures], [1, this.maxLen, this.featureDim]);
        const inputTextTensor = tf.tensor3d([paddedTextTokens], [1, this.maxLen, maxTokens]);

        const prediction = this.model.predict([inputIndicesTensor, inputFeaturesTensor, inputTextTensor]);

        // Get probabilities
        const probabilities = await prediction.data();

        inputIndicesTensor.dispose();
        inputFeaturesTensor.dispose();
        inputTextTensor.dispose();
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
        // Recover dimensions from model input shape
        // model.inputs[1].shape is [null, 60, featureDim]
        if (this.model.inputs && this.model.inputs.length > 1) {
            this.featureDim = this.model.inputs[1].shape[2];
        }
        // model.inputs[2].shape is [null, 60, maxTextTokens]
        if (this.model.inputs && this.model.inputs.length > 2) {
            this.maxTextTokens = this.model.inputs[2].shape[2];
        }
        this.model.summary();
    }
}
