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

    async initialize(vocabSize, featureDim, textVocabSize, maxNameTokens, maxKeywordsTokens, maxInkTokens, maxClassTokens, maxTypeTokens, maxBodyTokens) {
        // --- Save model parameters ---
        this.vocabSize = vocabSize + 1; // +1 for padding / OOV token
        this.featureDim = featureDim;
        this.textVocabSize = textVocabSize;
        this.maxNameTokens = maxNameTokens;
        this.maxKeywordsTokens = maxKeywordsTokens;
        this.maxInkTokens = maxInkTokens;
        this.maxClassTokens = maxClassTokens;
        this.maxTypeTokens = maxTypeTokens;
        this.maxBodyTokens = maxBodyTokens;

        // --- Define Inputs ---

        // 1. Numeric Features
        const inputFeatures = tf.input({
            shape: [this.maxLen, this.featureDim],
            dtype: 'float32',
            name: 'input_features'
        });

        // 2. Name Tokens
        const inputNameTokens = tf.input({
            shape: [this.maxLen, this.maxNameTokens],
            dtype: 'int32',
            name: 'input_name_tokens'
        });

        // 3. Keywords Tokens
        const inputKeywordsTokens = tf.input({
            shape: [this.maxLen, this.maxKeywordsTokens],
            dtype: 'int32',
            name: 'input_keywords_tokens'
        });

        // 4. Ink Tokens
        const inputInkTokens = tf.input({
            shape: [this.maxLen, this.maxInkTokens],
            dtype: 'int32',
            name: 'input_ink_tokens'
        });

        // 5. Classifications Tokens
        const inputClassTokens = tf.input({
            shape: [this.maxLen, this.maxClassTokens],
            dtype: 'int32',
            name: 'input_class_tokens'
        });

        // 6. Types Tokens
        const inputTypeTokens = tf.input({
            shape: [this.maxLen, this.maxTypeTokens],
            dtype: 'int32',
            name: 'input_type_tokens'
        });

        // 7. Body Text Tokens
        const inputBodyTokens = tf.input({
            shape: [this.maxLen, this.maxBodyTokens],
            dtype: 'int32',
            name: 'input_body_tokens'
        });

        // --- Embedding Layers ---
        const sharedEmbedding = tf.layers.embedding({
            inputDim: this.textVocabSize,
            outputDim: this.textEmbeddingDim,
            name: 'shared_text_embedding'
        });

        // Helper to process text input: Embedding -> Reshape -> Dense
        const processTextInput = (input, maxTokens, namePrefix, units) => {
            const embedding = sharedEmbedding.apply(input);
            const flattened = tf.layers.reshape({
                targetShape: [this.maxLen, maxTokens * this.textEmbeddingDim],
                name: `${namePrefix}_flatten`
            }).apply(embedding);
            return tf.layers.dense({
                units: units,
                activation: 'relu',
                name: `${namePrefix}_projection`
            }).apply(flattened);
        };

        const nameProjection = processTextInput(inputNameTokens, this.maxNameTokens, 'name', 8);
        const keywordsProjection = processTextInput(inputKeywordsTokens, this.maxKeywordsTokens, 'keywords', 12);
        const inkProjection = processTextInput(inputInkTokens, this.maxInkTokens, 'ink', 4);
        const classProjection = processTextInput(inputClassTokens, this.maxClassTokens, 'class', 8);
        const typeProjection = processTextInput(inputTypeTokens, this.maxTypeTokens, 'type', 4);
        const bodyProjection = processTextInput(inputBodyTokens, this.maxBodyTokens, 'body', 24);

        // --- Concatenate all features ---
        const concatenated = tf.layers.concatenate({
            name: 'concat_all_features'
        }).apply([
            inputFeatures,
            nameProjection,
            keywordsProjection,
            inkProjection,
            classProjection,
            typeProjection,
            bodyProjection
        ]);

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
            inputs: [
                inputFeatures,
                inputNameTokens,
                inputKeywordsTokens,
                inputInkTokens,
                inputClassTokens,
                inputTypeTokens,
                inputBodyTokens
            ],
            outputs: output,
            name: 'deck_predictor'
        });

        // --- Compile the model ---
        this.model.compile({
            optimizer: tf.train.adam(0.001),
            loss: 'sparseCategoricalCrossentropy',
            metrics: ['accuracy']
        });

        // --- Print summary for verification ---
        this.model.summary();
    }


    async train(sequences, featureSequences, textSequences, epochs, onEpochEnd) {
        // Frontend training is not typically used, but keeping signature consistent
        console.warn("Training in frontend is not fully implemented/optimized.");
    }

    prepareData(sequences, featureSequences) {
        return {};
    }

    async predict(cardIndices, cardFeatures, textInputs) {
        if (!this.model) return null;

        // Note: cardIndices are still passed for context (e.g. length), but NOT used as model input

        // Prepare input features
        const startIdx = Math.max(0, this.maxLen - cardIndices.length);

        const paddedFeatures = [];
        for (let k = 0; k < this.maxLen; k++) paddedFeatures.push(Array(this.featureDim).fill(0));
        for (let j = 0; j < Math.min(cardFeatures.length, this.maxLen); j++) {
            paddedFeatures[startIdx + j] = cardFeatures[j];
        }

        // Infer dimensions if missing (from model inputs)
        // inputs: [features, name, keywords, ink, class, type, body]
        if (!this.maxNameTokens && this.model.inputs.length > 1) {
            this.maxNameTokens = this.model.inputs[1].shape[2];
            this.maxKeywordsTokens = this.model.inputs[2].shape[2];
            this.maxInkTokens = this.model.inputs[3].shape[2];
            this.maxClassTokens = this.model.inputs[4].shape[2];
            this.maxTypeTokens = this.model.inputs[5].shape[2];
            this.maxBodyTokens = this.model.inputs[6].shape[2];
        }

        const paddedName = [];
        const paddedKeywords = [];
        const paddedInk = [];
        const paddedClass = [];
        const paddedType = [];
        const paddedBody = [];

        for (let k = 0; k < this.maxLen; k++) {
            paddedName.push(Array(this.maxNameTokens).fill(0));
            paddedKeywords.push(Array(this.maxKeywordsTokens).fill(0));
            paddedInk.push(Array(this.maxInkTokens).fill(0));
            paddedClass.push(Array(this.maxClassTokens).fill(0));
            paddedType.push(Array(this.maxTypeTokens).fill(0));
            paddedBody.push(Array(this.maxBodyTokens).fill(0));
        }

        if (textInputs) {
            for (let j = 0; j < Math.min(textInputs.length, this.maxLen); j++) {
                const textObj = textInputs[j];

                const padArray = (arr, max) => {
                    const sliced = arr.slice(0, max);
                    return sliced.concat(Array(max - sliced.length).fill(0));
                };

                paddedName[startIdx + j] = padArray(textObj.name, this.maxNameTokens);
                paddedKeywords[startIdx + j] = padArray(textObj.keywords, this.maxKeywordsTokens);
                paddedInk[startIdx + j] = padArray(textObj.ink, this.maxInkTokens);
                paddedClass[startIdx + j] = padArray(textObj.classifications, this.maxClassTokens);
                paddedType[startIdx + j] = padArray(textObj.types, this.maxTypeTokens);
                paddedBody[startIdx + j] = padArray(textObj.text, this.maxBodyTokens);
            }
        }

        const inputFeaturesTensor = tf.tensor3d([paddedFeatures], [1, this.maxLen, this.featureDim]);
        const inputNameTensor = tf.tensor3d([paddedName], [1, this.maxLen, this.maxNameTokens]);
        const inputKeywordsTensor = tf.tensor3d([paddedKeywords], [1, this.maxLen, this.maxKeywordsTokens]);
        const inputInkTensor = tf.tensor3d([paddedInk], [1, this.maxLen, this.maxInkTokens]);
        const inputClassTensor = tf.tensor3d([paddedClass], [1, this.maxLen, this.maxClassTokens]);
        const inputTypeTensor = tf.tensor3d([paddedType], [1, this.maxLen, this.maxTypeTokens]);
        const inputBodyTensor = tf.tensor3d([paddedBody], [1, this.maxLen, this.maxBodyTokens]);

        const prediction = this.model.predict([
            inputFeaturesTensor,
            inputNameTensor,
            inputKeywordsTensor,
            inputInkTensor,
            inputClassTensor,
            inputTypeTensor,
            inputBodyTensor
        ]);

        // Get probabilities
        const probabilities = await prediction.data();

        inputFeaturesTensor.dispose();
        inputNameTensor.dispose();
        inputKeywordsTensor.dispose();
        inputInkTensor.dispose();
        inputClassTensor.dispose();
        inputTypeTensor.dispose();
        inputBodyTensor.dispose();
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
