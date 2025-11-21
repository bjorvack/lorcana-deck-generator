import * as tf from '@tensorflow/tfjs';

export default class ValidationModel {
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

    async loadModel(path) {
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

        console.log('Validation model loaded successfully');
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

    async evaluateWithBreakdown(deckFeatures) {
        const score = await this.evaluate(deckFeatures);

        // Analyze which features contribute to low score
        const breakdown = this.analyzeFeatures(deckFeatures);

        return {
            score,
            grade: this.getGrade(score),
            message: this.getMessage(score),
            breakdown
        };
    }

    analyzeFeatures(deckFeatures) {
        // This method identifies problematic features
        // Feature indices (based on extractDeckFeatures):
        // 0-4: card count distribution (1 copy, 2, 3, 4, >4)
        // 5-14: mana curve (costs 1-10)
        // 15-18: type distribution (character, action, item, location)
        // 19-24: ink distribution (6 colors)
        // 25: inkable ratio
        // 26-34: keyword distribution (9 keywords)
        // 35: classification diversity
        // 36: synergy score

        const issues = [];

        // Check singleton ratio (too many cards with 1 copy)
        const singletonRatio = deckFeatures[0]; // 1 copy bucket
        if (singletonRatio > 0.3) {
            issues.push({
                issue: 'High singleton count',
                severity: 'high',
                message: `${Math.round(singletonRatio * 100)}% of unique cards have only 1 copy`
            });
        }

        // Check mana curve variance (should be peaked, not flat)
        const manaCurve = deckFeatures.slice(5, 15);
        const curveVariance = this.calculateVariance(manaCurve);
        if (curveVariance < 0.005) {
            issues.push({
                issue: 'Flat mana curve',
                severity: 'medium',
                message: 'Mana curve is too uniform (expected bell curve)'
            });
        }

        // Check inkable ratio (should be 50-70%)
        const inkableRatio = deckFeatures[25];
        if (inkableRatio < 0.4 || inkableRatio > 0.8) {
            issues.push({
                issue: 'Unusual inkable ratio',
                severity: 'medium',
                message: `${Math.round(inkableRatio * 100)}% inkable cards (expected 50-70%)`
            });
        }

        // Check type distribution (should have characters)
        const characterRatio = deckFeatures[15];
        if (characterRatio < 0.3) {
            issues.push({
                issue: 'Low character count',
                severity: 'high',
                message: `Only ${Math.round(characterRatio * 100)}% characters`
            });
        }

        // Check synergy score
        const synergyScore = deckFeatures[36];
        if (synergyScore < 0.1) {
            issues.push({
                issue: 'Low synergy',
                severity: 'medium',
                message: 'Cards appear to lack thematic cohesion'
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
}
