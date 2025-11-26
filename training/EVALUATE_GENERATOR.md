# Deck Generator Evaluation Script

## Overview

This script evaluates the quality of AI-generated decks by:
1. Generating N decks using the trained deck generator model
2. Scoring each deck with the validation model
3. Analyzing deck quality metrics
4. Providing a pass/fail assessment

## Usage

```bash
cd training
node evaluate-generator.js [num_decks]
```

**Parameters:**
- `num_decks` (optional): Number of decks to generate and evaluate (default: 10)

**Examples:**
```bash
# Evaluate 10 decks (default)
node evaluate-generator.js

# Evaluate 50 decks for more comprehensive analysis
node evaluate-generator.js 50

# Quick test with 5 decks
node evaluate-generator.js 5
```

## Output

### Validation Scores
- Average, min, max validation scores
- Standard deviation
- Grade distribution (A/B/C/D)

### Deck Quality Metrics
- Average unique cards (target: 15-20)
- Average inkable percentage (target: >50%)
- Average mana cost (target: 3.5-4.5)
- Average ink colors (target: 1-2)

### Success Criteria
✅ **PASS** if all criteria are met:
- Average validation score >70%
- Unique cards between 15-20
- Inkable cards >50%
- Average cost 3-5
- Ink colors ≤2

### Sample Deck Analysis
Detailed breakdown of the first generated deck including:
- Validation score
- Physical deck composition
- Top 10 most-used cards

## Target Metrics for Deck Generator

| Metric | Good Target | Excellent Target |
|--------|-------------|------------------|
| Avg Validation Score | >70% | >85% |
| Unique Cards | 15-20 | 16-19 |
| Inkable % | >50% | >60% |
| Avg Cost | 3.5-4.5 | 3.8-4.2 |
| Ink Colors | ≤2 | 1-2 |

## Important Note

⚠️ **Current Limitation**: The script currently uses a placeholder deck generation method (random legal cards). 

To get accurate results, you need to:
1. Implement proper deck generation in `DeckModel.js`
2. Or use the existing `DeckGenerator.js` logic
3. Update lines 300-330 in `evaluate-generator.js` with your actual generation code

## Prerequisites

- Trained deck generator model at `training_data/deck-generator-model/`
- Trained validation model at `training_data/deck-validator-model/`
- Vocabulary file at `training_data/vocabulary.json`

If any models are missing, train them first:
```bash
# Train deck generator
node train.js

# Train validation model
node train-validator.js
```

## Understanding the Results

### What Good Looks Like
```
Average: 82.5%
Grade Distribution:
  A (≥85%): 4 (40%)
  B (≥70%): 5 (50%)
  C (≥50%): 1 (10%)
  D (<50%): 0 (0%)

Average unique cards: 17.3 (target: 15-20) ✅
Average inkable %: 58.2% (target: >50%) ✅
Average cost: 4.1 (target: 3.5-4.5) ✅
Average ink colors: 1.8 (target: 1-2) ✅

Overall: PASS 🎉
```

### What Needs Improvement
```
Average: 45.2%
Grade Distribution:
  A (≥85%): 0 (0%)
  B (≥70%): 1 (10%)
  C (≥50%): 2 (20%)
  D (<50%): 7 (70%)

Average unique cards: 8.3 (target: 15-20) ❌
Average inkable %: 32.1% (target: >50%) ❌

Overall: NEEDS IMPROVEMENT ⚠️
```

## Troubleshooting

### Error: "Failed to load generator model"
- Make sure you've trained the deck generator: `node train.js`
- Check that `training_data/deck-generator-model/` exists

### Error: "Failed to load validation model"  
- Make sure you've trained the validator: `node train-validator.js`
- Check that `training_data/deck-validator-model/` exists

### Low validation scores (<50%)
- The generator model may need more training epochs
- Try full retrain: `node train.js --full-retrain`
- Check if generation logic is working correctly

### All decks look similar
- Increase temperature/randomness in generation
- Ensure diverse training data
- Check if the model is actually using predictions vs. random selection

## Next Steps After Evaluation

Based on results:

**If PASS (>70% avg):**
- ✅ Generator is working well
- Consider deploying or integrating into the app
- Monitor quality over time

**If FAIL (<70% avg):**
1. Review which criteria failed
2. If low unique cards → adjust generation to prefer diversity
3. If low validation score → train generator longer or with more data
4. If poor mana curve → adjust generation to balance costs
5. Re-train and re-evaluate

## Related Scripts

- `train.js` - Train the deck generator model
- `train-validator.js` - Train the validation model
- `validate-training-data.js` - Validate training data quality
- `test_partial_decks.js` - Test partial deck completion
