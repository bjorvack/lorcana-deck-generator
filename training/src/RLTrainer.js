const tf = require('@tensorflow/tfjs-node')

/**
 * RLTrainer - REINFORCE algorithm for training deck generator
 * Uses validator scores as reward signal to fine-tune policy network
 */
class RLTrainer {
  constructor (policyModel, validatorModel, trainingManager, options = {}) {
    this.policy = policyModel
    this.validator = validatorModel
    this.trainingManager = trainingManager

    // Hyperparameters
    this.learningRate = options.learningRate || 0.0001
    this.batchSize = options.batchSize || 10
    this.gamma = options.gamma || 0.99 // Discount factor
    this.useBaseline = options.useBaseline !== false // Default true
    this.entropyCoef = options.entropyCoef || 0.01 // Exploration bonus
    this.maxGradNorm = options.maxGradNorm || 1.0 // Gradient clipping

    // Optimizer
    this.optimizer = tf.train.adam(this.learningRate)

    // Metrics
    this.episodeRewards = []
    this.baseline = 0.5 // Running average of rewards

    // Experience Replay Buffer
    this.replayBufferSize = options.replayBufferSize || 500 // Reduced from 1000
    this.replayBuffer = []
    this.replayRatio = options.replayRatio || 0.3 // 30% of batch from replay
    this.minRewardForReplay = 0.6 // Only store episodes with reward >= this

    // Cache: Valid cards per ink combination (for fast lookup)
    this.validCardsCache = new Map()
    this._buildValidCardsCache()
  }

  /**
   * Build cache of valid card indices for each ink combination
   * This speeds up deck generation significantly
   */
  _buildValidCardsCache () {
    const allInks = ['Amber', 'Amethyst', 'Emerald', 'Ruby', 'Sapphire', 'Steel']
    const inkCombinations = []

    // Single-ink
    for (const ink of allInks) {
      inkCombinations.push([ink])
    }
    // Dual-ink
    for (let i = 0; i < allInks.length; i++) {
      for (let j = i + 1; j < allInks.length; j++) {
        inkCombinations.push([allInks[i], allInks[j]])
      }
    }

    for (const inks of inkCombinations) {
      const validCards = []
      for (const [idx, card] of this.trainingManager.indexMap) {
        const cardInks = card.inks || (card.ink ? [card.ink] : [])
        // Check if card can be used with these inks
        const isAllowed = cardInks.length === 0 || cardInks.every(ink => inks.includes(ink))
        if (isAllowed) {
          validCards.push(idx)
        }
      }
      const key = inks.sort().join('+')
      this.validCardsCache.set(key, validCards)
    }
    console.log(`[RL] Cached valid cards for ${this.validCardsCache.size} ink combinations`)
  }

  /**
   * Get cached valid cards for an ink combination
   */
  _getValidCards (inks) {
    const key = inks.sort().join('+')
    return this.validCardsCache.get(key) || []
  }

  /**
   * Add episode to replay buffer
   * Only stores high-quality episodes for replay
   */
  addToReplayBuffer (episode) {
    // Only store good episodes to improve sample efficiency
    if (episode.reward >= this.minRewardForReplay) {
      // Store a copy (not reference) to avoid mutation
      // Only store first and last state to save memory (intermediate states not needed)
      const statesToStore = [
        episode.states[0],  // First state
        episode.states[episode.states.length - 1]  // Last state (full deck)
      ]
      this.replayBuffer.push({
        states: statesToStore,
        actions: [...episode.actions],
        logProbs: [...episode.logProbs],
        reward: episode.reward
      })

      // Remove oldest if buffer full
      if (this.replayBuffer.length > this.replayBufferSize) {
        this.replayBuffer.shift()
      }
    }
  }

  /**
   * Sample from replay buffer for training
   * @param {Number} batchSize - Number of samples to return
   * @returns {Array} Sample episodes from buffer
   */
  sampleFromReplayBuffer (batchSize) {
    if (this.replayBuffer.length === 0) return []

    const samples = []
    const numSamples = Math.min(batchSize, this.replayBuffer.length)

    // Random sampling from buffer
    for (let i = 0; i < numSamples; i++) {
      const idx = Math.floor(Math.random() * this.replayBuffer.length)
      samples.push(this.replayBuffer[idx])
    }

    return samples
  }

  /**
   * Get replay buffer statistics
   */
  getReplayStats () {
    if (this.replayBuffer.length === 0) {
      return { size: 0, avgReward: 0, maxReward: 0 }
    }

    const rewards = this.replayBuffer.map(e => e.reward)
    return {
      size: this.replayBuffer.length,
      avgReward: rewards.reduce((a, b) => a + b, 0) / rewards.length,
      maxReward: Math.max(...rewards)
    }
  }

  /**
     * Collect one episode (generate one full deck)
     * Returns: { states, actions, logProbs, reward }
     */
  async collectEpisode (inks) {
    const episode = {
      states: [], // Deck states at each step
      actions: [], // Card indices chosen
      logProbs: [], // Log probabilities of actions
      reward: 0 // Terminal reward from validator
    }

    const deck = []
    const cardCounts = new Map()
    const deckKeywords = new Set() // Track keywords for synergy
    
    // Get cached valid cards for this ink combination
    const validCards = this._getValidCards(inks)

    // Generate deck card by card
    while (deck.length < 60) {
      // Current state
      episode.states.push([...deck])

      // Build context for synergy-aware prediction
      const context = {
        synergyMatrix: this.trainingManager.cooccurrenceMatrix,
        keywords: deckKeywords
      }

      // Get action probabilities from policy with context for synergy
      const probs = await this.policy.predictWithContext
        ? await this.policy.predictWithContext(deck, context)
        : await this.policy.predict(deck)

      // Sample action using policy (pass validCards for fast filtering)
      const { action, logProb } = this.sampleActionFromPolicy(probs, deck, cardCounts, inks, validCards)

      episode.actions.push(action)
      episode.logProbs.push(logProb)

      // Execute action
      deck.push(action)
      cardCounts.set(action, (cardCounts.get(action) || 0) + 1)

      // Update keyword tracking
      const cardKeywords = this.trainingManager.cardKeywordsMap.get(action)
      if (cardKeywords) {
        for (const kw of cardKeywords) {
          deckKeywords.add(kw)
        }
      }
    }

    // Get terminal reward from validator
    const deckFeatures = this.trainingManager.extractDeckFeaturesWithEmbeddings(deck)
    
    // Pass 'inks' context to validator.
    // The validator will penalize decks that don't match the learned ink profile patterns.
    const validatorReward = await this.validator.evaluate(deckFeatures, inks)

    // Store validator reward separately for logging
    episode.validatorReward = validatorReward

    // Calculate Consistency Reward (Bonus for multiple copies)
    const consistencyReward = this.calculateConsistencyReward(deck)

    // Calculate Synergy Rewards
    const synergyReward = this.calculateSynergyReward(deck)
    const keywordSynergyReward = this.calculateKeywordSynergyReward(deck)

    // Calculate Ability Combo Reward
    const abilityComboReward = this.calculateAbilityComboReward(deck)

    // Calculate New Rewards (Structure & Playability)
    const inkCurveScore = this.calculateInkCurveScore(deck)
    const cardTypeScore = this.calculateCardTypeScore(deck)
    const deckSizeScore = this.calculateDeckSizeScore(deck)
    const minInkScore = this.calculateMinimumInkScore(deck)
    const singletonPenaltyScore = this.calculateSingletonPenalty(deck)
    const uninkablePenaltyScore = this.calculateUninkablePenalty(deck)

    // Weighted sum:
    // Validator (Quality & Balance): 35% - Let the learned model decide what is "good"
    // Consistency (Structure): 8% - Reward playing multiple copies
    // Card Synergy: 10% - Reward cards that commonly appear together
    // Keyword Synergy: 7% - Reward complementary keywords
    // Ability Combo: 7% - Reward completing ability combos
    // Ink Curve: 7% - Reward balanced ink costs
    // Card Type: 7% - Reward proper character/action/item distribution
    // Deck Size: 4% - Reward exactly 60 cards
    // Minimum Ink: 5% - Reward having 4+ copies of each ink
    // Singleton Penalty: 5% - Penalize excessive singletons
    // Uninkable Penalty: 5% - Penalize excessive uninkable cards
    episode.reward = (validatorReward * 0.35) +
                     (consistencyReward * 0.08) +
                     (synergyReward * 0.10) +
                     (keywordSynergyReward * 0.07) +
                     (abilityComboReward * 0.07) +
                     (inkCurveScore * 0.07) +
                     (cardTypeScore * 0.07) +
                     (deckSizeScore * 0.04) +
                     (minInkScore * 0.05) +
                     (singletonPenaltyScore * 0.05) +
                     (uninkablePenaltyScore * 0.05)

    return episode
  }

  /**
   * Calculate consistency score based on card repetition
   * Returns 0.0 (all singletons) to ~1.0 (highly consistent)
   */
  calculateConsistencyReward (deck) {
    if (deck.length === 0) return 0

    const cardCounts = new Map()
    for (const idx of deck) {
      cardCounts.set(idx, (cardCounts.get(idx) || 0) + 1)
    }

    const uniqueCards = cardCounts.size
    const totalCards = deck.length

    // Repetition Ratio: 1.0 - (unique / total)
    // Examples (60 cards):
    // - 60 unique (1x each): 1 - 1 = 0.0
    // - 30 unique (2x each): 1 - 0.5 = 0.5
    // - 15 unique (4x each): 1 - 0.25 = 0.75
    const repetitionRatio = 1.0 - (uniqueCards / totalCards)

    // Boost the signal slightly to make it comparable to validator score
    return Math.min(1.0, repetitionRatio * 1.3)
  }

  /**
   * Calculate synergy reward based on learned co-occurrence patterns
   * Uses the training manager's co-occurrence matrix to score card synergies
   * @param {Array} deck - Array of card indices
   * @returns {Number} Synergy score (0-1)
   */
  calculateSynergyReward (deck) {
    if (deck.length < 2) return 0

    // Use the training manager's synergy methods
    const synergyScore = this.trainingManager.calculateDeckSynergy(deck)
    return synergyScore
  }

  /**
   * Calculate keyword synergy reward
   * @param {Array} deck - Array of card indices
   * @returns {Number} Keyword synergy score (0-1)
   */
  calculateKeywordSynergyReward (deck) {
    if (deck.length < 2) return 0

    // Collect all keywords from deck
    const deckKeywords = new Set()
    for (const cardId of deck) {
      const cardKeywords = this.trainingManager.cardKeywordsMap.get(cardId)
      if (cardKeywords) {
        for (const kw of cardKeywords) {
          deckKeywords.add(kw)
        }
      }
    }

    if (deckKeywords.size < 2) return 0

    // Calculate pairwise keyword synergies
    let totalSynergy = 0
    let count = 0
    const kwArray = Array.from(deckKeywords)

    for (let i = 0; i < Math.min(kwArray.length, 10); i++) {
      for (let j = i + 1; j < Math.min(kwArray.length, 10); j++) {
        const synergies = this.trainingManager.keywordSynergyMatrix.get(kwArray[i])
        if (synergies) {
          const score = synergies.get(kwArray[j])
          if (score) {
            totalSynergy += score
            count++
          }
        }
      }
    }

    return count > 0 ? Math.min(1, totalSynergy / count * 5) : 0
  }

  /**
   * Calculate ability combo reward
   * Rewards having complete ability combos (e.g., multiple singers)
   * @param {Array} deck - Array of card indices
   * @returns {Number} Combo reward (0-1)
   */
  calculateAbilityComboReward (deck) {
    return this.trainingManager.calculateAbilityComboScore(deck)
  }

  /**
   * Calculate ink curve score
   * Rewards balanced ink costs (1-2-3-4 curve)
   * Lorcana decks should have playable curves
   * @param {Array} deck - Array of card indices
   * @returns {Number} Curve score (0-1)
   */
  calculateInkCurveScore (deck) {
    if (deck.length === 0) return 0

    const inkCostCounts = {}
    let totalCards = 0

    for (const idx of deck) {
      const card = this.trainingManager.indexMap.get(idx)
      if (!card) continue

      const cost = card.cost || card.inkwell || 0
      inkCostCounts[cost] = (inkCostCounts[cost] || 0) + 1
      totalCards++
    }

    if (totalCards === 0) return 0

    // Ideal curve for Lorcana: 1-2 cost heavy, tapering 3-4, minimal 5+
    // Target distribution: ~25% 1-cost, ~30% 2-cost, ~25% 3-cost, ~15% 4-cost, ~5% 5+
    const idealDistribution = { 1: 0.25, 2: 0.30, 3: 0.25, 4: 0.15, 5: 0.05 }
    
    let score = 0
    let totalWeight = 0

    for (let cost = 1; cost <= 5; cost++) {
      const actual = (inkCostCounts[cost] || 0) / totalCards
      const ideal = idealDistribution[cost] || 0.01
      const diff = Math.abs(actual - ideal)
      
      // Closer to ideal = higher score
      const costScore = Math.max(0, 1 - diff * 4)
      score += costScore * ideal
      totalWeight += ideal
    }

    // Bonus for having playable cards (1-4 cost should be ~95% of deck)
    const playableRatio = ((inkCostCounts[1] || 0) + (inkCostCounts[2] || 0) + 
                           (inkCostCounts[3] || 0) + (inkCostCounts[4] || 0)) / totalCards
    const playableBonus = Math.min(playableRatio, 0.2) // Up to 0.2 bonus

    return Math.min(1, (score / totalWeight) * 0.8 + playableBonus)
  }

  /**
   * Calculate card type distribution score
   * Rewards proper character/action/item ratios
   * @param {Array} deck - Array of card indices
   * @returns {Number} Type distribution score (0-1)
   */
  calculateCardTypeScore (deck) {
    if (deck.length === 0) return 0

    const typeCounts = { Character: 0, Action: 0, Item: 0, Location: 0 }
    let totalCards = 0

    for (const idx of deck) {
      const card = this.trainingManager.indexMap.get(idx)
      if (!card) continue

      const type = card.type || card.cardType || 'Unknown'
      if (typeCounts[type] !== undefined) {
        typeCounts[type]++
      }
      totalCards++
    }

    if (totalCards === 0) return 0

    // Ideal distribution for Lorcana:
    // Characters: ~65% (40 cards) - need characters to win
    // Actions: ~25% (15 cards) - actions provide value
    // Items: ~8% (5 cards) - items are powerful but limited
    // Locations: ~2% (optional)
    const idealDistribution = { Character: 0.65, Action: 0.25, Item: 0.08, Location: 0.02 }

    let score = 0
    for (const [type, ideal] of Object.entries(idealDistribution)) {
      const actual = typeCounts[type] / totalCards
      const diff = Math.abs(actual - ideal)
      // Max score if matches ideal, decreases as it deviates
      score += Math.max(0, 1 - diff * 3)
    }

    // Also check minimum character count (need at least ~30 to be playable)
    const minCharacterRatio = 0.4
    const characterRatio = typeCounts.Character / totalCards
    if (characterRatio < minCharacterRatio) {
      score *= 0.5 // Heavy penalty for too few characters
    }

    return Math.min(1, score / 4) // Normalize to 0-1
  }

  /**
   * Calculate deck size score
   * Rewards having exactly 60 cards
   * @param {Array} deck - Array of card indices
   * @returns {Number} Size score (0-1)
   */
  calculateDeckSizeScore (deck) {
    const targetSize = 60
    const deckSize = deck.length

    if (deckSize === targetSize) return 1.0
    if (deckSize < targetSize) return deckSize / targetSize
    // Penalty for oversized decks
    return Math.max(0, 1 - (deckSize - targetSize) * 0.1)
  }

  /**
   * Calculate minimum ink count score
   * Ensures deck has at least 4 copies of each ink color
   * @param {Array} deck - Array of card indices
   * @returns {Number} Minimum ink score (0-1)
   */
  calculateMinimumInkScore (deck) {
    const inkCounts = {}
    let hasInk = false

    for (const idx of deck) {
      const card = this.trainingManager.indexMap.get(idx)
      if (!card) continue

      const cardInks = card.inks || (card.ink ? [card.ink] : [])
      for (const ink of cardInks) {
        inkCounts[ink] = (inkCounts[ink] || 0) + 1
        hasInk = true
      }
    }

    if (!hasInk) return 0

    // Check each ink has at least 4 copies
    let minInksWith4 = 0
    let totalInks = 0

    for (const ink of Object.keys(inkCounts)) {
      totalInks++
      if (inkCounts[ink] >= 4) {
        minInksWith4++
      }
    }

    // If using 1 ink: need at least 4 of that ink
    // If using 2 inks: need at least 4 of each ink
    // Score based on how many inks meet the threshold
    return totalInks > 0 ? minInksWith4 / totalInks : 0
  }

  /**
   * Calculate singleton penalty score
   * Penalizes decks with too many singleton cards (only 1 copy)
   * Real Lorcana decks typically have 15-25 unique cards
   * @param {Array} deck - Array of card indices
   * @returns {Number} Singleton score (0-1, higher is better)
   */
  calculateSingletonPenalty (deck) {
    if (deck.length === 0) return 0

    // Count unique cards and their copies
    const cardCounts = new Map()
    for (const idx of deck) {
      cardCounts.set(idx, (cardCounts.get(idx) || 0) + 1)
    }

    // Count singletons (cards with only 1 copy)
    let singletonCount = 0
    let uniqueCardCount = cardCounts.size

    for (const [, count] of cardCounts) {
      if (count === 1) {
        singletonCount++
      }
    }

    if (uniqueCardCount === 0) return 0

    const singletonRatio = singletonCount / uniqueCardCount

    // Ideal: 15-25% singletons (some flex cards)
    // Penalize heavily if >35% singletons
    // Penalize moderately if 25-35% singletons
    
    if (singletonRatio <= 0.25) {
      return 1.0 // Good: few singletons
    } else if (singletonRatio <= 0.35) {
      return 0.6 // Moderate penalty
    } else if (singletonRatio <= 0.5) {
      return 0.3 // Heavy penalty
    } else {
      return 0.0 // Fail: too many singletons
    }
  }

  /**
   * Calculate uninkable penalty score
   * Penalizes decks with too many uninkable (action/item) cards
   * Real Lorcana decks need ink to play cards
   * @param {Array} deck - Array of card indices
   * @returns {Number} Uninkable score (0-1, higher is better)
   */
  calculateUninkablePenalty (deck) {
    if (deck.length === 0) return 0

    let uninkableCount = 0

    for (const idx of deck) {
      const card = this.trainingManager.indexMap.get(idx)
      if (!card) continue

      // Check if card is uninkable (actions and items are typically uninkable)
      const type = card.type || card.cardType || ''
      const isUninkable = type === 'Action' || type === 'Item' || type === 'Location'
      
      // Some characters might also be uninkable if they have certain abilities
      if (!card.ink && !card.inks) {
        uninkableCount++
      } else if (isUninkable) {
        uninkableCount++
      }
    }

    const uninkableRatio = uninkableCount / deck.length

    // Ideal: ~20-30% uninkable cards (actions + items)
    // Penalize if >40% uninkable
    
    if (uninkableRatio <= 0.25) {
      return 1.0 // Good
    } else if (uninkableRatio <= 0.35) {
      return 0.7 // Minor penalty
    } else if (uninkableRatio <= 0.45) {
      return 0.4 // Moderate penalty
    } else {
      return 0.1 // Heavy penalty
    }
  }

  /**
     * Sample action from policy with exploration
     * Filters invalid actions (exceeds max count)
     */
  sampleActionFromPolicy (probs, currentDeck, cardCounts, allowedInks, validCardsCache = null) {
    // Create array from Float32Array
    let probsArray = Array.from(probs)

    // Apply VERY STRONG repetition bias to achieve ~30-40% singleton rate
    // With 2000+ cards and 60 picks, random = 95%+ singletons
    // Need exponential boost to prefer existing cards
    // Strategy: 
    // - If deck has 0-10 cards: moderate boost (5x)
    // - If deck has 11-30 cards: strong boost (20x)  
    // - If deck has 30+ cards: extreme boost (50x) to close out deck
    const deckSize = currentDeck.length
    let repeatBoost = 5.0
    if (deckSize > 30) repeatBoost = 50.0
    else if (deckSize > 10) repeatBoost = 20.0
    
    for (let i = 0; i < probsArray.length; i++) {
      const count = cardCounts.get(i) || 0
      if (count > 0) {
        // Apply exponential bonus based on existing count
        probsArray[i] *= Math.pow(repeatBoost, count)
      }
    }

    // Mask invalid actions (cards at max count or wrong ink)
    // Use cached valid cards if available for fast filtering
    const maskedProbs = probsArray.map((p, idx) => {
      // Fast path: use cached valid cards
      if (validCardsCache && validCardsCache.length > 0) {
        if (!validCardsCache.includes(idx)) return 0
      } else {
        // Slow path: check ink constraints
        const card = this.trainingManager.indexMap.get(idx)
        if (!card) return 0

        const cardInks = card.inks || (card.ink ? [card.ink] : [])
        if (allowedInks && allowedInks.length > 0 && cardInks.length > 0) {
          if (!cardInks.every(ink => allowedInks.includes(ink))) return 0
        }
      }
      
      // Check max count (applies to both paths)
      const count = cardCounts.get(idx) || 0
      const maxAmount = 4 // Default max
      if (count >= maxAmount) return 0

      return p
    })

    // Renormalize
    const sum = maskedProbs.reduce((a, b) => a + b, 0)
    if (sum === 0) {
      // Fallback: uniform over valid actions
      const validActions = maskedProbs.map((p, i) => {
        // Re-check validity since p is 0
        const card = this.trainingManager.indexMap.get(i)
        if (!card) return -1
        const count = cardCounts.get(i) || 0
        const maxAmount = card.maxAmount || 4
        if (count >= maxAmount) return -1

        if (allowedInks && allowedInks.length > 0) {
          const cardInks = card.inks || (card.ink ? [card.ink] : [])
          if (cardInks.length > 0 && !cardInks.every(ink => allowedInks.includes(ink))) return -1
        }
        return i
      }).filter(i => i >= 0)

      if (validActions.length === 0) {
        console.warn('No valid actions available!')
        return { action: 0, logProb: 0 }
      }
      const action = validActions[Math.floor(Math.random() * validActions.length)]
      return { action, logProb: Math.log(1.0 / validActions.length) }
    }

    const normalized = maskedProbs.map(p => p / sum)

    // Sample from categorical distribution
    const rand = Math.random()
    let cumsum = 0
    for (let i = 0; i < normalized.length; i++) {
      cumsum += normalized[i]
      if (rand < cumsum) {
        const logProb = Math.log(Math.max(normalized[i], 1e-10))
        return { action: i, logProb }
      }
    }

    // Fallback (shouldn't reach here)
    const action = normalized.length - 1
    const logProb = Math.log(Math.max(normalized[action], 1e-10))
    return { action, logProb }
  }

  /**
     * Compute returns for an episode using reward-to-go
     * Each step receives the discounted sum of future rewards only
     */
  computeReturns (episode) {
    const returns = []
    let discountedReturn = 0

    // Use reward-to-go: each step gets the discounted sum of rewards from that point forward
    // This provides better credit assignment than giving all steps the same reward
    for (let t = episode.logProbs.length - 1; t >= 0; t--) {
      discountedReturn = episode.reward * Math.pow(this.gamma, episode.logProbs.length - 1 - t) + discountedReturn
      returns.unshift(discountedReturn)
    }

    return returns
  }

  /**
     * Train one step: collect episodes and update policy
     */
  async trainStep (inks) {
    console.log(`\n[RL] Collecting ${this.batchSize} episodes...`)
    const episodes = []

    // Collect batch of episodes
    for (let i = 0; i < this.batchSize; i++) {
      const episode = await this.collectEpisode(inks)
      episodes.push(episode)

      // Add to replay buffer
      this.addToReplayBuffer(episode)

      process.stdout.write(`\r  Episode ${i + 1}/${this.batchSize}: reward = ${episode.reward.toFixed(3)}`)
    }
    console.log('') // Newline

    // Mix in replay samples if available
    let allEpisodes = episodes
    if (this.replayBuffer.length > 0) {
      const replaySamples = this.sampleFromReplayBuffer(
        Math.floor(this.batchSize * this.replayRatio)
      )
      if (replaySamples.length > 0) {
        allEpisodes = [...episodes, ...replaySamples]
        console.log(`[RL] Replay buffer: ${this.replayBuffer.length} episodes (using ${replaySamples.length} in this batch)`)
      }
    }

    // Compute statistics
    const rewards = episodes.map(ep => ep.reward)
    const avgReward = rewards.reduce((a, b) => a + b, 0) / rewards.length
    const stdReward = Math.sqrt(
      rewards.reduce((sum, r) => sum + Math.pow(r - avgReward, 2), 0) / rewards.length
    )

    // Update baseline
    if (this.useBaseline) {
      this.baseline = this.baseline * 0.9 + avgReward * 0.1 // EMA
    }

    // Compute policy gradient and update (use all episodes for training)
    const lossValue = await this.updatePolicy(allEpisodes)

    // Track metrics
    this.episodeRewards.push(avgReward)

    // Print replay stats
    const replayStats = this.getReplayStats()
    console.log(`[RL] Replay: ${replayStats.size} episodes, avg reward: ${replayStats.avgReward.toFixed(3)}`)
    console.log(`[RL] Avg Reward: ${avgReward.toFixed(4)} ± ${stdReward.toFixed(4)}`)
    console.log(`[RL] Baseline: ${this.baseline.toFixed(4)}`)
    console.log(`[RL] Loss: ${lossValue.toFixed(4)}`)

    return {
      avgReward,
      stdReward,
      baseline: this.baseline,
      loss: lossValue,
      replayStats
    }
  }

  /**
     * Update policy using REINFORCE algorithm
     */
  async updatePolicy (episodes) {
    // 1. Prepare data
    const states = []
    const actions = []
    const advantages = []

    for (const episode of episodes) {
      const returns = this.computeReturns(episode)

      for (let t = 0; t < episode.states.length; t++) {
        // Pad state to maxLen
        const deck = episode.states[t]
        const paddedSeq = new Array(this.policy.maxLen).fill(0)
        const startIdx = Math.max(0, this.policy.maxLen - deck.length)
        for (let j = 0; j < Math.min(deck.length, this.policy.maxLen); j++) {
          paddedSeq[startIdx + j] = deck[j]
        }

        states.push(paddedSeq)
        actions.push(episode.actions[t])

        const advantage = this.useBaseline
          ? returns[t] - this.baseline
          : returns[t]
        advantages.push(advantage)
      }
    }

    // 2. Convert to Tensors
    const statesTensor = tf.tensor2d(states, [states.length, this.policy.maxLen], 'int32')
    const actionsTensor = tf.tensor1d(actions, 'int32')
    const advantagesTensor = tf.tensor1d(advantages, 'float32')

    // 3. Compute Gradients & Update
    const lossFunction = () => {
      // Forward pass
      const logits = this.policy.model.predict(statesTensor)

      // Calculate log probs
      // Add epsilon to avoid log(0)
      const logProbs = tf.log(tf.add(logits, 1e-10))

      // Select log prob of taken actions
      const actionMask = tf.oneHot(actionsTensor, this.policy.vocabSize)
      const selectedLogProbs = tf.sum(tf.mul(logProbs, actionMask), 1)

      // Loss = -mean(log_prob * advantage)
      // We want to maximize reward, so minimize negative reward
      const loss = tf.mean(tf.mul(tf.neg(selectedLogProbs), advantagesTensor))

      // Add entropy regularization
      if (this.entropyCoef > 0) {
        const entropy = tf.neg(tf.sum(tf.mul(logits, logProbs), 1))
        const meanEntropy = tf.mean(entropy)
        return tf.sub(loss, tf.mul(meanEntropy, this.entropyCoef))
      }

      return loss
    }

    // Apply gradients
    // minimize returns the value of the loss function
    const varList = this.policy.model.trainableWeights.map(w => w.val)
    const loss = this.optimizer.minimize(lossFunction, true, varList)

    const lossValue = loss.dataSync()[0]

    // Cleanup
    statesTensor.dispose()
    actionsTensor.dispose()
    advantagesTensor.dispose()
    loss.dispose()

    return lossValue
  }

  /**
     * Main training loop
     */
  async train (options = {}) {
    const numEpochs = options.numEpochs || 100
    const saveInterval = options.saveInterval || 10
    const savePath = options.savePath || './training_data/deck-generator-rl'
    const decksPerInk = options.decksPerInk || 10 // Number of decks to generate per ink combo per epoch
    const maxTimeMinutes = options.maxTimeMinutes || null
    const startTime = Date.now()

    // Generate all possible ink combinations (single and dual)
    const allInks = ['Amber', 'Amethyst', 'Emerald', 'Ruby', 'Sapphire', 'Steel']
    const inkCombinations = []

    // Single-ink decks (6 combinations)
    for (let i = 0; i < allInks.length; i++) {
      inkCombinations.push([allInks[i]])
    }

    // Two-ink decks (15 combinations)
    for (let i = 0; i < allInks.length; i++) {
      for (let j = i + 1; j < allInks.length; j++) {
        inkCombinations.push([allInks[i], allInks[j]])
      }
    }

    console.log('\n=== Starting RL Training ===')
    console.log(`Epochs: ${numEpochs}`)
    console.log(`Decks per ink: ${decksPerInk}`)
    console.log(`Total decks per epoch: ${inkCombinations.length * decksPerInk}`)
    console.log(`Learning Rate: ${this.learningRate}`)
    console.log(`Ink Combinations: ${inkCombinations.length} (6 mono-color + 15 dual-color)`)
    console.log('================================\n')

    let combinationIndex = 0

    for (let epoch = 0; epoch < numEpochs; epoch++) {
      // Check time limit
      if (maxTimeMinutes) {
        const elapsedMinutes = (Date.now() - startTime) / 60000
        if (elapsedMinutes >= maxTimeMinutes) {
          console.log(`\n⏰ Time limit of ${maxTimeMinutes} minutes reached. Stopping training.`)
          break
        }
      }

      console.log(`\n--- Epoch ${epoch + 1}/${numEpochs} ---`)

      // Collect episodes from ALL ink combinations this epoch
      // Use PARALLEL deck generation for speedup
      const shuffledInks = [...inkCombinations].sort(() => Math.random() - 0.5)

      // Build list of all (inks, deckIndex) pairs to generate
      const tasks = []
      for (const inks of shuffledInks) {
        for (let d = 0; d < decksPerInk; d++) {
          tasks.push({ inks, deckIdx: d })
        }
      }

      console.log(`  Generating ${tasks.length} decks in parallel (max 10 at a time)...`)

      // Generate decks in batches of 10 to limit memory usage
      const startTime = Date.now()
      let completed = 0
      const total = tasks.length
      const batchSize = 10
      
      // Simple progress bar
      const progressWidth = 30
      const updateProgress = () => {
        const percent = completed / total
        const filled = Math.floor(percent * progressWidth)
        const bar = '█'.repeat(filled) + '░'.repeat(progressWidth - filled)
        process.stdout.write(`\r  [${bar}] ${completed}/${total} decks`)
      }

      // Process in batches
      const allEpisodes = []
      for (let i = 0; i < tasks.length; i += batchSize) {
        const batch = tasks.slice(i, i + batchSize)
        
        // Run batch in parallel
        const batchPromises = batch.map(task =>
          this.collectEpisode(task.inks).then(episode => {
            completed++
            updateProgress()
            return episode
          })
        )
        
        const batchEpisodes = await Promise.all(batchPromises)
        allEpisodes.push(...batchEpisodes)
      }
      console.log('') // Newline after progress
      
      // Add all to replay buffer
      for (const episode of allEpisodes) {
        this.addToReplayBuffer(episode)
      }

      const elapsed = Date.now() - startTime
      console.log(`  Generated ${allEpisodes.length} decks in ${elapsed}ms`)

      // Shuffle all episodes before policy update (Fisher-Yates)
      for (let i = allEpisodes.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [allEpisodes[i], allEpisodes[j]] = [allEpisodes[j], allEpisodes[i]];
      }

      // Calculate statistics for this epoch
      const rewards = allEpisodes.map(ep => ep.reward)
      const avgReward = rewards.reduce((a, b) => a + b, 0) / rewards.length
      const stdReward = Math.sqrt(
        rewards.reduce((sum, r) => sum + Math.pow(r - avgReward, 2), 0) / rewards.length
      )

      // Calculate validator-only scores (what validator would give without RL rules)
      const validatorRewards = allEpisodes.map(ep => ep.validatorReward || 0)
      const avgValidatorScore = validatorRewards.reduce((a, b) => a + b, 0) / validatorRewards.length

      // Update baseline
      if (this.useBaseline) {
        this.baseline = this.baseline * 0.9 + avgReward * 0.1
      }

      // Update policy using all collected episodes
      const lossValue = await this.updatePolicy(allEpisodes)
      this.episodeRewards.push(avgReward)

      // Print epoch summary
      const replayStats = this.getReplayStats()
      console.log(`[RL] Epoch ${epoch + 1} Summary:`)
      console.log(`  Avg Reward: ${avgReward.toFixed(4)} ± ${stdReward.toFixed(4)}`)
      console.log(`  Validator Score: ${avgValidatorScore.toFixed(4)} (raw validator approval)`)
      console.log(`  Baseline: ${this.baseline.toFixed(4)}`)
      console.log(`  Loss: ${lossValue.toFixed(4)}`)
      console.log(`  Replay: ${replayStats.size} episodes (avg: ${replayStats.avgReward.toFixed(3)})`)

      // Clear episode data to free memory
      allEpisodes.length = 0

      // Save checkpoint
      if ((epoch + 1) % saveInterval === 0) {
        const checkpointPath = `${savePath}_epoch${epoch + 1}`
        await this.policy.saveModel(checkpointPath)
        console.log(`[RL] Saved checkpoint to ${checkpointPath}`)
      }

      // Early stopping
      if (avgReward >= 0.9) {
        console.log('\n[RL] Reached target reward of 0.9! Stopping early.')
        break
      }
    }

    // Final save
    await this.policy.saveModel(savePath)
    console.log(`\n[RL] Training complete! Final model saved to ${savePath}`)

    // Print summary
    console.log('\n=== Training Summary ===')
    console.log(`Final Avg Reward: ${this.episodeRewards[this.episodeRewards.length - 1].toFixed(4)}`)
    console.log(`Best Reward: ${Math.max(...this.episodeRewards).toFixed(4)}`)
    console.log(`Improvement: ${(this.episodeRewards[this.episodeRewards.length - 1] - this.episodeRewards[0]).toFixed(4)}`)
    console.log(`Trained on ${inkCombinations.length} ink combinations x ${decksPerInk} decks per epoch`)
  }
}

module.exports = RLTrainer
