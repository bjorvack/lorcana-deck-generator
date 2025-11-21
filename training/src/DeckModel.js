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
        if (!this.model) {
            throw new Error("Model not initialized");
        }

        const {
            xsFeatures,
            xsName,
            xsKeywords,
            xsInk,
            xsClass,
            xsType,
            xsBody,
            ys
        } = this.prepareData(sequences, featureSequences, textSequences);

        // Early stopping: stop if validation loss doesn't improve for 3 epochs
        let bestValLoss = Infinity;
        let patienceCounter = 0;
        const patience = 3;

        await this.model.fit(
            [xsFeatures, xsName, xsKeywords, xsInk, xsClass, xsType, xsBody],
            ys,
            {
                epochs: epochs || 10,
                batchSize: 64,
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
            }
        );

        xsFeatures.dispose();
        xsName.dispose();
        xsKeywords.dispose();
        xsInk.dispose();
        xsClass.dispose();
        xsType.dispose();
        xsBody.dispose();
        ys.dispose();
    }

    prepareData(sequences, featureSequences, textSequences) {
        const xsFeatures = [];
        const xsName = [];
        const xsKeywords = [];
        const xsInk = [];
        const xsClass = [];
        const xsType = [];
        const xsBody = [];
        const ys = [];

        sequences.forEach((seq, seqIdx) => {
            const featSeq = featureSequences[seqIdx];
            const textSeq = textSequences[seqIdx]; // Array of objects

            // Limit max examples per deck
            const step = Math.max(1, Math.floor(seq.length / 10));

            for (let i = 1; i < seq.length; i += step) {
                const inputSeqIndices = seq.slice(0, i);
                const inputSeqFeatures = featSeq.slice(0, i);
                const inputSeqText = textSeq.slice(0, i);
                const target = seq[i];

                const startIdx = Math.max(0, this.maxLen - inputSeqIndices.length);

                // Pad Features
                const paddedFeatures = [];
                for (let k = 0; k < this.maxLen; k++) paddedFeatures.push(Array(this.featureDim).fill(0));
                for (let j = 0; j < Math.min(inputSeqFeatures.length, this.maxLen); j++) {
                    paddedFeatures[startIdx + j] = inputSeqFeatures[j];
                }

                // Pad Text Inputs
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

                for (let j = 0; j < Math.min(inputSeqText.length, this.maxLen); j++) {
                    const textObj = inputSeqText[j];
                    paddedName[startIdx + j] = textObj.name;
                    paddedKeywords[startIdx + j] = textObj.keywords;
                    paddedInk[startIdx + j] = textObj.ink;
                    paddedClass[startIdx + j] = textObj.classifications;
                    paddedType[startIdx + j] = textObj.types;
                    paddedBody[startIdx + j] = textObj.text;
                }

                xsFeatures.push(paddedFeatures);
                xsName.push(paddedName);
                xsKeywords.push(paddedKeywords);
                xsInk.push(paddedInk);
                xsClass.push(paddedClass);
                xsType.push(paddedType);
                xsBody.push(paddedBody);
                ys.push(target);
            }
        });

        return {
            xsFeatures: tf.tensor3d(xsFeatures, [xsFeatures.length, this.maxLen, this.featureDim]),
            xsName: tf.tensor3d(xsName, [xsName.length, this.maxLen, this.maxNameTokens]),
            xsKeywords: tf.tensor3d(xsKeywords, [xsKeywords.length, this.maxLen, this.maxKeywordsTokens]),
            xsInk: tf.tensor3d(xsInk, [xsInk.length, this.maxLen, this.maxInkTokens]),
            xsClass: tf.tensor3d(xsClass, [xsClass.length, this.maxLen, this.maxClassTokens]),
            xsType: tf.tensor3d(xsType, [xsType.length, this.maxLen, this.maxTypeTokens]),
            xsBody: tf.tensor3d(xsBody, [xsBody.length, this.maxLen, this.maxBodyTokens]),
            ys: tf.tensor1d(ys)
        };
    }

    async predict(cardIndices, cardFeatures, textInputs) {
        if (!this.model) return null;

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

        // Recover dimensions from model input shape
        // model.inputs[0].shape is [null, 60, featureDim]
        if (this.model.inputs && this.model.inputs.length > 0) {
            this.featureDim = this.model.inputs[0].shape[2];
        }
        // model.inputs[1].shape is [null, 60, maxNameTokens]
        if (this.model.inputs && this.model.inputs.length > 1) {
            this.maxNameTokens = this.model.inputs[1].shape[2];
        }
        // model.inputs[2].shape is [null, 60, maxKeywordsTokens]
        if (this.model.inputs && this.model.inputs.length > 2) {
            this.maxKeywordsTokens = this.model.inputs[2].shape[2];
        }
        // model.inputs[3].shape is [null, 60, maxInkTokens]
        if (this.model.inputs && this.model.inputs.length > 3) {
            this.maxInkTokens = this.model.inputs[3].shape[2];
        }
        // model.inputs[4].shape is [null, 60, maxClassTokens]
        if (this.model.inputs && this.model.inputs.length > 4) {
            this.maxClassTokens = this.model.inputs[4].shape[2];
        }
        // model.inputs[5].shape is [null, 60, maxTypeTokens]
        if (this.model.inputs && this.model.inputs.length > 5) {
            this.maxTypeTokens = this.model.inputs[5].shape[2];
        }
        // model.inputs[6].shape is [null, 60, maxBodyTokens]
        if (this.model.inputs && this.model.inputs.length > 6) {
            this.maxBodyTokens = this.model.inputs[6].shape[2];
        }
        this.model.summary();
    }
}
