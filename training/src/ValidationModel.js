const tf = require('@tensorflow/tfjs-node');

/**
 * Validation Model - Set-based binary classifier
 * Aggregates embeddings across entire deck (order-independent)
 * to learn card co-occurrence patterns
 */
module.exports = class ValidationModel {
    constructor() {
        this.model = null;
        this.embeddingDim = 32;
    }

    async initialize(textVocabSize, numericFeatureDim) {
        this.textVocabSize = textVocabSize;
        this.numericFeatureDim = numericFeatureDim;

        console.log('\n=== Validation Model Architecture ===');
        console.log(`Text vocabulary size: ${this.textVocabSize}`);
        console.log(`Numeric feature dimension: ${this.numericFeatureDim}`);
        console.log(`Embedding dimension: ${this.embeddingDim}`);

        // Input: deck-level aggregated features
        // This will include:
        // - Mean/max/var of text embeddings across deck
        // - Statistical features (mana curve, type dist, etc.)
        const inputDim = this.numericFeatureDim + (this.embeddingDim * 3); // mean + max + variance

        const input = tf.input({
            shape: [inputDim],
            dtype: 'float32',
            name: 'deck_features'
        });

        // Dense layers with L2 regularization to prevent overfitting on embeddings
        let x = tf.layers.dense({
            units: 128,
            activation: 'relu',
            kernelRegularizer: tf.regularizers.l2({ l2: 0.01 }),
            name: 'dense_1'
        }).apply(input);

        x = tf.layers.dropout({
            rate: 0.5,  // Increased from 0.3
            name: 'dropout_1'
        }).apply(x);

        x = tf.layers.dense({
            units: 64,
            activation: 'relu',
            kernelRegularizer: tf.regularizers.l2({ l2: 0.01 }),
            name: 'dense_2'
        }).apply(x);

        x = tf.layers.dropout({
            rate: 0.5,  // Increased from 0.3
            name: 'dropout_2'
        }).apply(x);

        x = tf.layers.dense({
            units: 32,
            activation: 'relu',
            kernelRegularizer: tf.regularizers.l2({ l2: 0.01 }),
            name: 'dense_3'
        }).apply(x);

        const output = tf.layers.dense({
            units: 1,
            activation: 'sigmoid',
            name: 'output'
        }).apply(x);

        this.model = tf.model({
            inputs: input,
            outputs: output,
            name: 'validation_model'
        });

        this.model.compile({
            optimizer: tf.train.adam(0.001),
            loss: 'binaryCrossentropy',
            metrics: ['accuracy']
        });

        this.model.summary();
    }

    async train(features, labels, epochs = 20) {
        console.log('\nTraining validation model...');
        console.log(`Training on ${labels.length} decks...`);

        const featuresTensor = tf.tensor2d(features);
        const labelsTensor = tf.tensor2d(labels.map(l => [l]));

        // Split train/val
        const splitIdx = Math.floor(labels.length * 0.8);

        const history = await this.model.fit(
            featuresTensor.slice([0, 0], [splitIdx, features[0].length]),
            labelsTensor.slice([0, 0], [splitIdx, 1]),
            {
                epochs: epochs,
                batchSize: 32,
                validationData: [
                    featuresTensor.slice([splitIdx, 0], [labels.length - splitIdx, features[0].length]),
                    labelsTensor.slice([splitIdx, 0], [labels.length - splitIdx, 1])
                ],
                callbacks: {
                    onEpochEnd: (epoch, logs) => {
                        console.log(`Epoch ${epoch + 1}/${epochs}: loss = ${logs.loss.toFixed(4)}, acc = ${logs.acc.toFixed(4)}, val_loss = ${logs.val_loss.toFixed(4)}, val_acc = ${logs.val_acc.toFixed(4)}`);
                    }
                }
            }
        );

        featuresTensor.dispose();
        labelsTensor.dispose();

        console.log('Training complete!');
        return history;
    }

    async evaluate(features) {
        // First, check for explicit rule-based failures
        const uniqueCardDiversity = features[0]; // First feature is unique card count / 20
        const estimatedUniqueCards = Math.round(uniqueCardDiversity * 20);

        // Hard rule: if fewer than 10 unique cards, immediately fail
        if (estimatedUniqueCards < 10) {
            console.log(`[RULE] Low diversity detected: ${estimatedUniqueCards} unique cards - returning 0.0`);
            return 0.0; // Override neural network - this is clearly fake
        }

        // Otherwise, use neural network prediction
        const featuresTensor = tf.tensor2d([features]);
        const prediction = this.model.predict(featuresTensor);
        const score = await prediction.data();
        featuresTensor.dispose();
        prediction.dispose();
        return score[0];
    }

    async evaluateWithBreakdown(features) {
        const score = await this.evaluate(features);
        const grade = this.getGrade(score);
        const message = this.getMessage(score);

        // Analyze features for breakdown
        const breakdown = this.analyzeFeatures(features);

        return { score, grade, message, breakdown };
    }

    analyzeFeatures(features) {
        // Features are: [numeric features (38), mean embeddings (32), max embeddings (32), variance embeddings (32)]
        const numericStart = 0;
        const numericEnd = this.numericFeatureDim;
        const varStart = numericEnd + (this.embeddingDim * 2);

        const numericFeatures = features.slice(numericStart, numericEnd);
        const embeddingVariance = features.slice(varStart, varStart + this.embeddingDim);

        const issues = [];

        // Check unique card diversity (feature 0)
        const uniqueCardDiversity = numericFeatures[0];
        const estimatedUniqueCards = Math.round(uniqueCardDiversity * 20);
        if (estimatedUniqueCards < 10) {
            issues.push({
                issue: 'Very low card diversity',
                severity: 'high',
                message: `Only ~${estimatedUniqueCards} unique cards (expected 15-20)`
            });
        }

        // Check embedding variance (low variance = repetitive cards)
        const avgVariance = embeddingVariance.reduce((a, b) => a + b, 0) / embeddingVariance.length;
        if (avgVariance < 0.01) {
            issues.push({
                issue: 'Repetitive card patterns',
                severity: 'high',
                message: 'Cards are too similar (detected via semantic analysis)'
            });
        }

        // Check singleton ratio
        const singletonRatio = numericFeatures[1];
        if (singletonRatio > 0.3) {
            issues.push({
                issue: 'High singleton count',
                severity: 'high',
                message: `${Math.round(singletonRatio * 100)}% of unique cards have only 1 copy`
            });
        }

        // Check inkable ratio (warn only if < 50%)
        const inkableRatio = numericFeatures[26];
        if (inkableRatio < 0.5) {
            issues.push({
                issue: 'Low inkable ratio',
                severity: 'medium',
                message: `Only ${Math.round(inkableRatio * 100)}% inkable cards (recommended at least 50%)`
            });
        }

        return issues;
    }

    getGrade(score) {
        if (score >= 0.85) return 'A';
        if (score >= 0.70) return 'B';
        if (score >= 0.50) return 'C';
        return 'D';
    }

    getMessage(score) {
        if (score >= 0.85) return 'This deck looks authentic!';
        if (score >= 0.70) return 'This deck looks realistic with minor issues';
        if (score >= 0.50) return 'This deck has some unrealistic patterns';
        return 'This deck seems randomly generated';
    }

    async saveModel(path) {
        await this.model.save(`file://${path}`);
        console.log(`Validation model saved to ${path}`);
    }

    async loadModel(path) {
        this.model = await tf.loadLayersModel(`file://${path}/model.json`);
        console.log(`Validation model loaded from ${path}`);
    }
};
