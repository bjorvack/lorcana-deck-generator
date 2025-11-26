# Deck Generator Evaluation Results

## Summary

Created and ran `evaluate-generator.js` to assess AI-generated deck quality.

## Current Performance

| Metric | Current | Target | Status |
|--------|---------|--------|--------|
| Avg Score | 28.7% | >70% | ❌ FAIL |
| Unique Cards | 42.4 | 15-20 | ❌ FAIL |
| Inkable % | 69.7% | >50% | ✅ PASS |
| Avg Cost | 3.18 | 3-5 | ✅ PASS |
| Ink Colors | 6.0 | 1-2 | ❌ FAIL |

### Grade Distribution
- A (≥85%): 0 (0%)
- B (≥70%): 0 (0%)  
- **C (≥50%): 2 (40%)**
- **D (<50%): 3 (60%)**

**Best Deck:** 59.7% (C grade)

## Progress Made

### ✅ Improvements from Random Baseline
- **Random generation: 0.0%** → **AI generation: 28.7%** (infinite improvement!)
- Model shows some learning (best deck 59.7%)
- Cards are being repeated (e.g., 4x Hidden Inkcaster)
- Reasonable mana curve and inkable ratio

### ❌ Critical Issues

1. **Too Many Unique Cards (42.4 vs 15-20)**
   - Tournament decks have 15-20 unique cards with multiple copies
   - AI decks have 42.4 unique cards → too diverse, not enough synergy
   - **Root cause:** Model not learning to repeat strong cards

2. **All 6 Ink Colors (vs 1-2)**
   - Tournament decks focus on 1-2 colors for consistency
   - AI picks from all 6 colors → no color synergy
   - **Root cause:** Model not learning color constraints

3. **High Variance (3.8% to 59.7%)**
   - Some decks are decent (59.7%), others terrible (3.8%)
   - Inconsistent quality suggests unstable learning
   - **Root cause:** Model hasn't converged to good patterns

## Root Cause Analysis

The deck generator model's low performance (28.7% avg) suggests:

### 1. Insufficient Training
The model may need:
- More training epochs
- More diverse training data
- Better loss convergence

### 2. Architecture Issues
Current architecture (simple LSTM):
```
Card IDs → Embedding (64) → LSTM (128) → Dense (vocabSize)
```

May be too simple for the task. Consider:
- Deeper LSTM layers
- Attention mechanisms
- Explicit ink/cost conditioning

### 3. Training Data Quality
If training on raw tournament decks without guidance:
- Model sees cards in different orders
- Doesn't learn deck-building principles
- Just memorizes sequences

## Recommended Next Steps

### Immediate (Quick Wins)

1. **Lower Temperature** (Line 308 in evaluate-generator.js)
   ```javascript
   const temperature = 1.2; // Try 0.8 instead
   ```
   Lower temperature = less randomness = more consistent decks

2. **Check Training Accuracy**
   Run: `node train.js` and check final training accuracy
   - Target: >15-20% (remember it's 1869 classes!)
   - If <10%, model hasn't learned anything

3. **Run More Training Epochs**
   ```bash
   node train.js 50  # Instead of default epochs
   ```

### Medium Term (Architecture Improvements)

4. **Add Ink Color Conditioning**
   Modify model to:
   - Pick 1-2 ink colors first
   - Only predict cards of those colors
   - Would force color consistency

5. **Add Deck-Building Rewards**
   During training, reward:
   - Cards that match existing inks (+reward)
   - Duplicate strong cards (+reward)
   - Balanced mana curve (+reward)

6. **Increase Model Capacity**
   ```javascript
   lstmUnits: 256,  // Instead of 128
   embeddingDim: 128, // Instead of 64
   ```

### Long Term (Training Strategy)

7. **Reinforcement Learning**
   Already have RL setup in `train_rl.js`!
   - Train with validation score as reward
   - Model learns to maximize validation score
   - Should converge to better decks

8. **Curriculum Learning**
   - Start with simpler constraints (1 color only)
   - Gradually increase complexity
   - Easier for model to learn fundamentals

9. **Guided Generation**
   Instead of pure autoregressive:
   - First: Pick ink colors (1-2)
   - Second: Pick core cards (4x copies)
   - Third: Fill remaining slots
   - Forces structure onto generation

## Evaluation Script

**Location:** `training/evaluate-generator.js`

**Usage:**
```bash
cd training
node evaluate-generator.js [num_decks]

# Examples
node evaluate-generator.js 5    # Quick test
node evaluate-generator.js 20   # Comprehensive
node evaluate-generator.js 100  # Production quality check
```

**Output:** Comprehensive analysis including:
- Validation scores (avg, min, max, std dev)
- Grade distribution
- Deck quality metrics
- Sample deck breakdown
- Pass/fail criteria

## Files Created

1. `evaluate-generator.js` - Main evaluation script
2. `EVALUATE_GENERATOR.md` - Usage documentation
3. `EVALUATION_RESULTS.md` - This file

## Conclusion

**Good News:**
- ✅ Evaluation framework working perfectly
- ✅ AI generation is 28.7% vs 0% random (shows learning!)
- ✅ Some decks reach 59.7% (C grade)
- ✅ Basic constraints working (60 cards, legality, max amounts)

**Bad News:**
- ❌ Still far from tournament quality (need 70%+)
- ❌ Too diverse (42 unique cards vs 15-20)
- ❌ No color focus (all 6 colors)

**Verdict:** The generator shows promise but needs more training and/or architectural improvements to reach production quality.

**Recommended Action:** Try lowering temperature to 0.8 and training for more epochs. If that doesn't help, consider implementing the RL training pipeline which should directly optimize for validation score.
