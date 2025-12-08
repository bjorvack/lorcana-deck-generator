import * as tf from '@tensorflow/tfjs'

export default class ValidationModel {
  constructor () {
    this.model = null
    this.featureDim = 0
    this.thresholds = {
      excellent: 0.85,
      good: 0.70,
      fair: 0.50,
      poor: 0
    }
  }

  async loadModel (path) {
    this.model = await tf.loadLayersModel(path)
    this.model.compile({
      optimizer: 'adam',
      loss: 'binaryCrossentropy',
      metrics: ['accuracy']
    })

    // Recover feature dimension from model input shape
    if (this.model.inputs && this.model.inputs.length > 0) {
      this.featureDim = this.model.inputs[0].shape[1]
    }

    console.log('Validation model loaded successfully')
  }

  async evaluate (deckFeatures) {
    if (!this.model) return null

    // --- HARD RULES (Immediate Fail) ---

    // 1. Deck Size Check (This is usually handled before calling evaluate, but good to have)
    // Note: deckFeatures doesn't explicitly contain deck size, but we can infer or pass it.
    // For now, we assume the caller checks deck size (ModelManager.validateDeck does).

    // 2. Unique Card Diversity (Rule: > 10 unique cards)
    const uniqueCardDiversity = deckFeatures[0] // First feature is unique card count / 20
    const estimatedUniqueCards = Math.round(uniqueCardDiversity * 20)

    if (estimatedUniqueCards < 10) {
      console.log(`[RULE] Low diversity detected: ${estimatedUniqueCards} unique cards - returning 0.0`)
      return 0.0
    }

    // 3. Max 2 Inks Check
    // Ink counts are at indices 20-25 (Amber, Amethyst, Emerald, Ruby, Sapphire, Steel)
    // These are normalized by totalCards. If > 0, the ink is present.
    const inkCounts = deckFeatures.slice(20, 26)
    const activeInks = inkCounts.filter(count => count > 0.001) // Use small epsilon for float comparison

    if (activeInks.length > 2) {
      console.log(`[RULE] Too many inks detected: ${activeInks.length} - returning 0.0`)
      return 0.0
    }

    // 4. Max 4 Copies Check (RELAXED)
    // User feedback: Some cards (e.g. Dalmation Puppy) allow > 4 copies.
    // Instead of a hard fail, we will let the neural network decide, but log a warning.
    // We can also apply a small penalty to the score later if needed, or handle it in analyzeFeatures.

    const moreThanFourRatio = deckFeatures[5]
    if (moreThanFourRatio > 0) {
      console.log('[WARNING] Cards with > 4 copies detected. This may be valid for specific cards (e.g. Dalmation Puppy).')
      // Do NOT return 0.0 here.
    }

    // --- NEURAL NETWORK EVALUATION ---

    const input = tf.tensor2d([deckFeatures])
    const prediction = this.model.predict(input)
    const score = (await prediction.data())[0]

    input.dispose()
    prediction.dispose()

    return score
  }

  async evaluateWithBreakdown (deckFeatures) {
    const score = await this.evaluate(deckFeatures)

    // Analyze which features contribute to low score
    const breakdown = this.analyzeFeatures(deckFeatures)

    return {
      score,
      grade: this.getGrade(score),
      message: this.getMessage(score),
      breakdown
    }
  }

  analyzeFeatures (deckFeatures) {
    // Feature indices:
    // 0: unique card diversity (normalized by 20)
    // 1: 1 copy ratio
    // 2: 2 copy ratio
    // 3: 3 copy ratio
    // 4: 4 copy ratio
    // 5: >4 copy ratio
    // 6-15: mana curve (costs 1-10)
    // 16-19: type distribution (character, action, item, location)
    // 20-25: ink distribution (6 colors)
    // 26: inkable ratio
    // 27-35: keyword distribution
    // 36: classification diversity
    // 37: synergy score

    const issues = []

    // 1. Diversity Check
    const uniqueCardDiversity = deckFeatures[0]
    const estimatedUniqueCards = Math.round(uniqueCardDiversity * 20)
    if (estimatedUniqueCards < 12) {
      issues.push({
        issue: 'Low Card Diversity',
        severity: 'high',
        message: `Only ~${estimatedUniqueCards} unique cards. Aim for 15-20 for a versatile deck.`
      })
    } else if (estimatedUniqueCards > 25) {
      issues.push({
        issue: 'Too Many Unique Cards',
        severity: 'medium',
        message: `~${estimatedUniqueCards} unique cards. Consistency might suffer.`
      })
    }

    // Check singleton ratio (too many cards with 1 copy)
    const singletonRatio = deckFeatures[1] // Updated index
    if (singletonRatio > 0.3) {
      issues.push({
        issue: 'High singleton count',
        severity: 'high',
        message: `${Math.round(singletonRatio * 100)}% of unique cards have only 1 copy`
      })
    }

    // Check for > 4 copies (New Check)
    const moreThanFourRatio = deckFeatures[5]
    if (moreThanFourRatio > 0) {
      issues.push({
        issue: 'Excessive Card Copies',
        severity: 'medium', // Not high/critical because of Dalmation Puppy
        message: 'Some cards have > 4 copies. Ensure this is valid (e.g. Dalmation Puppy).'
      })
    }

    // Check ink distribution (indices 20-25)
    const twoOfRatio = deckFeatures[2]
    if (twoOfRatio > 0.4) {
      issues.push({
        issue: 'Lack of Focus',
        severity: 'low',
        message: 'High number of 2-copy cards. Commit to 4 copies for your best cards.'
      })
    }

    // 4. Ink Count Check
    const inkCounts = deckFeatures.slice(20, 26)
    const activeInks = inkCounts.filter(count => count > 0.001)
    if (activeInks.length > 2) {
      issues.push({
        issue: 'Illegal Deck',
        severity: 'critical',
        message: `Deck uses ${activeInks.length} inks. Maximum allowed is 2.`
      })
    } else if (activeInks.length === 2) {
      // Check for splash balance
      const sortedInks = [...activeInks].sort((a, b) => a - b)
      const minorInkRatio = sortedInks[0]
      // Assuming 60 card deck for estimation
      const minorInkCount = Math.round(minorInkRatio * 60)

      if (minorInkCount < 6) {
        issues.push({
          issue: 'Unreliable Ink Splash',
          severity: 'medium',
          message: `Secondary ink has only ~${minorInkCount} cards. You might struggle to find ink for them.`
        })
      }
    }

    // 5. Inkable Ratio Check
    const inkableRatio = deckFeatures[26]
    if (inkableRatio < 0.60) { // Increased from 0.50
      issues.push({
        issue: 'Risk of Bricking',
        severity: 'high',
        message: `Only ${Math.round(inkableRatio * 100)}% cards are inkable. Aim for >75% to ensure you can play cards.`
      })
    } else if (inkableRatio < 0.75) {
      issues.push({
        issue: 'Low Inkable Count',
        severity: 'medium',
        message: `${Math.round(inkableRatio * 100)}% inkable. You might miss land drops occasionally.`
      })
    }

    // 6. Character Count Check
    const characterRatio = deckFeatures[16]
    if (characterRatio < 0.5) {
      issues.push({
        issue: 'Low Character Count',
        severity: 'high',
        message: `Only ${Math.round(characterRatio * 100)}% characters. You need characters to quest and challenge.`
      })
    }

    // 7. Mana Curve Check
    const manaCurve = deckFeatures.slice(6, 16)
    // Check for early game presence (Cost 1-3)
    const earlyGameSum = manaCurve.slice(0, 3).reduce((a, b) => a + b, 0)
    if (earlyGameSum < 0.2) { // < 12 cards
      issues.push({
        issue: 'Slow Start',
        severity: 'high',
        message: 'Very few 1-3 cost cards. You risk falling behind early.'
      })
    }

    // Check for top end (Cost 5+)
    const lateGameSum = manaCurve.slice(4).reduce((a, b) => a + b, 0)
    if (lateGameSum < 0.15) { // < 9 cards
      issues.push({
        issue: 'Lack of Finishers',
        severity: 'medium',
        message: 'Few high-cost cards. You might run out of steam in the late game.'
      })
    }

    // 8. Uninkable Count Check (Heuristic)
    // uninkable = 1 - inkableRatio
    const uninkableRatio = 1 - inkableRatio
    const estimatedUninkables = Math.round(uninkableRatio * 60)
    if (estimatedUninkables > 16) {
      issues.push({
        issue: 'Too Many Uninkables',
        severity: 'high',
        message: `~${estimatedUninkables} uninkable cards. This will cause consistency issues.`
      })
    }

    // 9. Synergy Score Check (Classification Based)
    const synergyScore = deckFeatures[37]
    if (synergyScore < 0.15) {
      issues.push({
        issue: 'Low Tribal Synergy',
        severity: 'medium',
        message: 'Cards do not seem to share strong thematic or mechanical links (Classifications).'
      })
    }

    // 10. Semantic Synergy Score (Hidden Synergy - Embedding Variance)
    // Variance features are the last 32 elements of the array
    const embeddingDim = 32
    const totalFeatures = deckFeatures.length
    const varianceStart = totalFeatures - embeddingDim
    const varianceFeatures = deckFeatures.slice(varianceStart)

    // Calculate average variance (Lower is better/more consistent)
    const avgVariance = varianceFeatures.reduce((a, b) => a + b, 0) / embeddingDim

    // Convert to a 0-1 score.
    // Typical variance for random decks is high (~0.15-0.2).
    // Consistent decks are lower (~0.05-0.1).
    // Let's map 0.0 -> 1.0 (Perfect) and 0.2 -> 0.0 (Random)
    const semanticSynergy = Math.max(0, 1 - (avgVariance * 5))

    if (semanticSynergy < 0.4) {
      issues.push({
        issue: 'Low Semantic Synergy',
        severity: 'medium',
        message: `Cards have very different text/effects (Score: ${(semanticSynergy * 100).toFixed(0)}%). They might not work well together.`
      })
    } else if (semanticSynergy > 0.7) {
      // This is a positive "issue" (Good job!)
      issues.push({
        issue: 'High Semantic Synergy',
        severity: 'info',
        message: `Cards share similar text/effects (Score: ${(semanticSynergy * 100).toFixed(0)}%). Strong mechanical consistency.`
      })
    }

    return issues
  }

  calculateVariance (arr) {
    const mean = arr.reduce((sum, val) => sum + val, 0) / arr.length
    const squaredDiffs = arr.map(val => Math.pow(val - mean, 2))
    return squaredDiffs.reduce((sum, val) => sum + val, 0) / arr.length
  }

  getGrade (score) {
    if (score >= this.thresholds.excellent) return 'A'
    if (score >= this.thresholds.good) return 'B'
    if (score >= this.thresholds.fair) return 'C'
    return 'D'
  }

  getMessage (score) {
    if (score >= this.thresholds.excellent) {
      return 'This deck looks authentic!'
    } else if (score >= this.thresholds.good) {
      return 'This deck looks realistic with minor issues'
    } else if (score >= this.thresholds.fair) {
      return 'This deck has some unrealistic patterns'
    } else {
      return 'This deck seems randomly generated'
    }
  }
}
