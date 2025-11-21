const tf = require('@tensorflow/tfjs-node');

module.exports = class ValidationModel {
    constructor() {
        this.model = null;
        this.featureDim = 0;
        this.thresholds = {
            excellent: 0.85,
            good: 0.70,
            fair: 0.50,
            poor: 0
        };
    }

    async initialize(featureDim) {
        this.featureDim = featureDim;

        // Build a feedforward binary classifier
        const input = tf.input({
            shape: [this.featureDim],
            dtype: 'float32',
            name: 'deck_features'
        });

        // Hidden layers with dropout for regularization
        let hidden = tf.layers.dense({
            units: 128,
            activation: 'relu',
            name: 'dense_1'
        }).apply(input);

        hidden = tf.layers.dropout({
            rate: 0.3,
            name: 'dropout_1'
        }).apply(hidden);

        hidden = tf.layers.dense({
            units: 64,
            activation: 'relu',
            name: 'dense_2'
        }).apply(hidden);

        hidden = tf.layers.dropout({
            rate: 0.3,
            name: 'dropout_2'
        }).apply(hidden);

        hidden = tf.layers.dense({
            units: 32,
            activation: 'relu',
            name: 'dense_3'
        }).apply(hidden);

        // Output layer: sigmoid for binary classification (real vs fake)
        const output = tf.layers.dense({
            units: 1,
            activation: 'sigmoid',
            name: 'output'
        }).apply(hidden);

        // Create and compile the model
        this.model = tf.model({
            inputs: input,
            outputs: output,
            name: 'deck_validator'
        });

        this.model.compile({
            optimizer: tf.train.adam(0.001),
            loss: 'binaryCrossentropy',
            metrics: ['accuracy']
        });

        this.model.summary();
    }

    async train(deckFeatures, labels, epochs = 20, onEpochEnd) {
        if (!this.model) {
            throw new Error("Model not initialized");
        }

        console.log(`Training on ${deckFeatures.length} decks...`);

        const xs = tf.tensor2d(deckFeatures);
        const ys = tf.tensor2d(labels.map(l => [l])); // Reshape to [n, 1]

        // Early stopping
        let bestValLoss = Infinity;
        let patienceCounter = 0;
        const patience = 5;

        await this.model.fit(xs, ys, {
            epochs: epochs,
            batchSize: 32,
            validationSplit: 0.2,
            shuffle: true,
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

        xs.dispose();
        ys.dispose();
    }

    async evaluate(deckFeatures) {
        if (!this.model) return null;

        const input = tf.tensor2d([deckFeatures]);
        const prediction = this.model.predict(input);
        const score = (await prediction.data())[0];

        input.dispose();
        prediction.dispose();

        return score;
    }

    async evaluateWithBreakdown(deckFeatures, featureNames) {
        const score = await this.evaluate(deckFeatures);

        // Analyze which features contribute to low score
        const breakdown = this.analyzeFeatures(deckFeatures, featureNames);

        return {
            score,
            grade: this.getGrade(score),
            breakdown
        };
    }

    analyzeFeatures(deckFeatures, featureNames) {
        // This method identifies problematic features
        // Feature indices (based on extractDeckFeatures):
        // 0-9: card count distribution (0-1 copies, 1-2, 2-3, 3-4, 4)
        // 10-19: mana curve (costs 1-10)
        // 20-23: type distribution (character, action, item, location)
        // 24-29: ink distribution
        // 30: inkable ratio
        // 31+: synergy metrics, keyword distribution, etc.

        const issues = [];

        // Check singleton ratio (too many cards with 1 copy)
        const singletonRatio = deckFeatures[0]; // 0-1 copy bucket
        if (singletonRatio > 0.3) {
            issues.push({
                issue: 'High singleton count',
                severity: 'high',
                message: `${Math.round(singletonRatio * 100)}% of deck has only 1 copy (expected <30%)`
            });
        }

        // Check mana curve variance (should be peaked, not flat)
        const manaCurve = deckFeatures.slice(10, 20);
        const curveVariance = this.calculateVariance(manaCurve);
        if (curveVariance < 0.005) {
            issues.push({
                issue: 'Flat mana curve',
                severity: 'medium',
                message: 'Mana curve is too uniform (expected bell curve)'
            });
        }

        // Check inkable ratio (should be 50-70%)
        const inkableRatio = deckFeatures[30];
        if (inkableRatio < 0.4 || inkableRatio > 0.8) {
            issues.push({
                issue: 'Unusual inkable ratio',
                severity: 'medium',
                message: `${Math.round(inkableRatio * 100)}% inkable cards (expected 50-70%)`
            });
        }

        // Check type distribution (should have characters)
        const characterRatio = deckFeatures[20];
        if (characterRatio < 0.3) {
            issues.push({
                issue: 'Low character count',
                severity: 'high',
                message: `Only ${Math.round(characterRatio * 100)}% characters (expected >30%)`
            });
        }

        return issues;
    }

    calculateVariance(arr) {
        const mean = arr.reduce((sum, val) => sum + val, 0) / arr.length;
        const squaredDiffs = arr.map(val => Math.pow(val - mean, 2));
        return squaredDiffs.reduce((sum, val) => sum + val, 0) / arr.length;
    }

    getGrade(score) {
        if (score >= this.thresholds.excellent) return 'A';
        if (score >= this.thresholds.good) return 'B';
        if (score >= this.thresholds.fair) return 'C';
        return 'D';
    }

    getMessage(score) {
        if (score >= this.thresholds.excellent) {
            return 'This deck looks authentic!';
        } else if (score >= this.thresholds.good) {
            return 'This deck looks realistic with minor issues';
        } else if (score >= this.thresholds.fair) {
            return 'This deck has some unrealistic patterns';
        } else {
            return 'This deck seems randomly generated';
        }
    }

    async saveModel(path) {
        if (!this.model) return;
        if (!path.startsWith('file://')) {
            path = `file://${path}`;
        }
        await this.model.save(path);
        console.log(`Validation model saved to ${path}`);
    }

    async loadModel(path) {
        if (!path.startsWith('file://')) {
            path = `file://${path}`;
        }
        this.model = await tf.loadLayersModel(path);
        this.model.compile({
            optimizer: 'adam',
            loss: 'binaryCrossentropy',
            metrics: ['accuracy']
        });

        // Recover feature dimension from model input shape
        if (this.model.inputs && this.model.inputs.length > 0) {
            this.featureDim = this.model.inputs[0].shape[1];
        }

        this.model.summary();
    }
};
