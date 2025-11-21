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

        // Rule-based override: if fewer than 10 unique cards, immediately fail
        const uniqueCardDiversity = deckFeatures[0]; // First feature is unique card count / 20
        const estimatedUniqueCards = Math.round(uniqueCardDiversity * 20);

        if (estimatedUniqueCards < 10) {
            console.log(`[RULE] Low diversity detected: ${estimatedUniqueCards} unique cards - returning 0.0`);
            return 0.0; // Override neural network - this is clearly fake
        }

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
        // Feature indices (updated with unique card count):
        // 0: unique card diversity (normalized by 20)
        // 1-5: card count distribution (1 copy, 2, 3, 4, >4)
        // 6-15: mana curve (costs 1-10)
        // 16-19: type distribution (character, action, item, location)
        // 20-25: ink distribution (6 colors)
        // 26: inkable ratio
        // 27-35: keyword distribution (9 keywords)
        // 36: classification diversity
        // 37: synergy score

        const issues = [];

        // Check unique card diversity (NEW - most important!)
        const uniqueCardDiversity = deckFeatures[0]; // Normalized by 20
        const estimatedUniqueCards = Math.round(uniqueCardDiversity * 20);
        if (estimatedUniqueCards < 10) {
            issues.push({
                issue: 'Very low card diversity',
                severity: 'high',
                message: `Only ~${estimatedUniqueCards} unique cards (expected 15-20)`
            });
        } else if (estimatedUniqueCards > 25) {
            issues.push({
                issue: 'Too many unique cards',
                severity: 'medium',
                message: `~${estimatedUniqueCards} unique cards (expected 15-20)`
            });
        }

        // Check singleton ratio (too many cards with 1 copy)
        const singletonRatio = deckFeatures[1]; // Updated index
        if (singletonRatio > 0.3) {
            issues.push({
                issue: 'High singleton count',
                severity: 'high',
                message: `${Math.round(singletonRatio * 100)}% of unique cards have only 1 copy`
            });
        }

        // Check mana curve variance (should be peaked, not flat)
        const manaCurve = deckFeatures.slice(6, 16); // Updated indices
        const curveVariance = this.calculateVariance(manaCurve);
        if (curveVariance < 0.005) {
            issues.push({
                issue: 'Flat mana curve',
                severity: 'medium',
                message: 'Mana curve is too uniform (expected bell curve)'
            });
        }

        // Check inkable ratio (warn only if < 50%)
        const inkableRatio = deckFeatures[26]; // Updated index
        if (inkableRatio < 0.5) {
            issues.push({
                issue: 'Low inkable ratio',
                severity: 'medium',
                message: `Only ${Math.round(inkableRatio * 100)}% inkable cards (recommended at least 50%)`
            });
        }

        // Check type distribution (should have characters)
        const characterRatio = deckFeatures[16]; // Updated index
        if (characterRatio < 0.3) {
            issues.push({
                issue: 'Low character count',
                severity: 'high',
                message: `Only ${Math.round(characterRatio * 100)}% characters`
            });
        }

        // Check synergy score
        const synergyScore = deckFeatures[37]; // Updated index
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
