export default class DeckGenerator {
  constructor(cards, weightCalculator) {
    this.weightCalculator = weightCalculator
    this.cards = cards
    this.currentDistribution = null

    this.useDefaultDistribution()
    this.initializeCardRequirements()
  }

  useAggroDistribution() {
    this.currentDistribution = {
      1: 12,
      2: 20,
      3: 12,
      4: 8,
      5: 8,
    }
  }

  useDefaultDistribution() {
    this.currentDistribution = {
      1: 8,
      2: 12,
      3: 20,
      4: 12,
      5: 8,
    }
  }

  initializeCardRequirements() {
    for (const index in this.cards) {
      const cardText = this.cards[index].sanitizedText

      if (cardText === undefined || cardText === null || cardText === '') {
        continue
      }

      const gainRegex = /gains? \w+(\s\+\d)?/g
      const compareText = cardText.replace(gainRegex, '')

      for (const keyword of this.keywords) {
        if (compareText.includes(keyword.toLowerCase())) {
          this.cards[index].requiredKeywords.push(keyword)
        }
      }

      for (const classification of this.classifications) {
        let challengeText = `challenges a ${classification.toLowerCase()}`

        let compareText = cardText.replace(challengeText, '')

        if (compareText.includes(classification.toLowerCase())) {
          this.cards[index].requiredClassifications.push(classification)
        }
      }

      for (const type of this.types) {
        if (type === 'Character') {
          continue // Skip Character type, since they are almost always required
        }

        if (type === 'Item') {
          const chosenItemRegex = /(?:chosen item of yours|your items?|reveal an item)/g

          if (cardText.match(chosenItemRegex)) {
            this.cards[index].requiredTypes.push(type)
          }

          continue
        }

        if (cardText.includes(type.toLowerCase())) {
          this.cards[index].requiredTypes.push(type)
        }
      }

      for (const cardName of this.cardNames) {
        if (cardText.includes(` ${cardName.toLowerCase()}`)) {
          this.cards[index].requiredCardNames.push(cardName)
        }
      }

      if (this.cards[index].hasShift) {
        let name = [this.cards[index].name]
        if (this.cards[index].name.includes('&')) {
          name = this.cards[index].name.split('&').map(name => name.trim())
        }

        this.cards[index].requiredCardNames.push(...name)
      }

      // Make each requirement unique
      this.cards[index].requiredKeywords = [...new Set(this.cards[index].requiredKeywords)]
      this.cards[index].requiredClassifications = [...new Set(this.cards[index].requiredClassifications)]
      this.cards[index].requiredTypes = [...new Set(this.cards[index].requiredTypes)]
      this.cards[index].requiredCardNames = [...new Set(this.cards[index].requiredCardNames)]
    }
  }

  get keywords() {
    // Get all unique keywords from the cards
    return [
      'Ward',
      'Evasive',
      'Bodyguard',
      'Resist',
      'Singer',
      'Shift',
      'Reckless',
      'Challenger',
      'Rush',
    ]
  }

  get classifications() {
    // Get all unique classifications from the cards
    return [...new Set(this.cards.map(card => card.classifications).flat())]
  }

  get types() {
    // Get all unique types from the cards
    return [...new Set(this.cards.map(card => card.types).flat())]
  }

  get cardNames() {
    // Get all unique card names from the cards
    return [...new Set(this.cards.map(card => card.name))]
  }

  generateDeck(
    inks,
    deck = [],
    deckType = 'default',
    triesRemaining = 50
  ) {
    console.log(`Generating ${deckType} deck, ${triesRemaining} tries remaining`)
    const cardsOfInk = this.cards.filter(card => {
      if (card.inks.length === 1 && inks.includes(card.inks[0])) {
        return true
      }

      let hasAllInks = true;

      for (const ink of inks) {
        if (!card.inks.includes(ink)) {
          hasAllInks = false;
          break;
        }
      }

      return hasAllInks;
    })
    if (cardsOfInk.length === 0) {
      return []
    }
    do {
      let chosenCard = this.pickRandomCard(cardsOfInk, deck, deckType, triesRemaining)
      deck.push(chosenCard)
    } while (!this.isDeckValid(deck))

    if (triesRemaining >= 0) {
      triesRemaining--
      deck = this.validateAndRetry(deck, deckType, triesRemaining)
    }

    return deck
  }

  pickRandomCost(deck) {
    // Pick a random card cost based on a bell curve, with the peak at 3
    // Lower the chance of picking a cost by its amount in the deck

    const chanceOfCost = {
      1: this.currentDistribution[1] - deck.filter(card => card.cost === 1).length,
      2: this.currentDistribution[2] - deck.filter(card => card.cost === 2).length,
      3: this.currentDistribution[3] - deck.filter(card => card.cost === 3).length,
      4: this.currentDistribution[4] - deck.filter(card => card.cost === 4).length,
      5: this.currentDistribution[5] - deck.filter(card => card.cost >= 5).length,
    }

    const totalChance = Object.values(chanceOfCost).reduce((total, chance) => total + chance, 0)
    const randomChance = Math.random() * totalChance

    let currentChance = 0
    let pickedCost = null
    for (const cost in chanceOfCost) {
      currentChance += chanceOfCost[cost]
      if (currentChance >= randomChance) {
        pickedCost = cost
        break
      }
    }

    return parseInt(pickedCost)
  }

  pickRandomCard(cards, deck, deckType, triesRemaining) {
    const pickedCost = this.pickRandomCost(deck)
    const cardsOfCost = cards.filter(card => {
      if (pickedCost === 5) {
        return card.cost >= pickedCost
      }

      return card.cost === pickedCost
    })

    const legalCardsOfCost = cardsOfCost.filter(card => {
      console.log(card)
      return card.legality === 'legal'
    })

    const weights = legalCardsOfCost.map(card => {
      return {
        card,
        weight: this.weightCalculator.calculateWeight(card, deck, deckType, triesRemaining)
      }
    })

    let pickableCards = weights.filter(weight => weight.weight > 0)
    // if a card is 4 times in a deck remove it from the pickable cards
    pickableCards = pickableCards.filter(weight => {
      const countInDeck = deck.filter(deckCard => deckCard.title === weight.card.title).length
      return countInDeck < weight.card.maxAmount
    })

    const totalWeight = pickableCards.reduce((total, weight) => total + weight.weight, 0)
    const randomWeight = Math.floor(Math.random() * totalWeight)
    let currentWeight = 0
    let pickedCard = null
    for (const weight of pickableCards) {
      currentWeight += weight.weight
      if (currentWeight >= randomWeight) {
        pickedCard = weight.card
        break
      }
    }

    return pickedCard
  }

  isDeckValid(deck) {
    return deck.length >= 60
  }

  validateAndRetry(deck, deckType, triesRemaining) {
    let deckLength = deck.length
    let previousDeckLength = deckLength = null
    do {
      console.log('Removing cards without requirements')
      previousDeckLength = deckLength
      deck = this.removeCardsWithoutRequirements(deck)
      deckLength = deck.length
    } while (deckLength !== previousDeckLength)

    const cardsWithSingleCopy = deck.filter(card => deck.filter(deckCard => deckCard.id === card.id).length === 1)
    if (cardsWithSingleCopy.length > 4) {
      console.log('Removing cards with single copy')
      for (const card of cardsWithSingleCopy) {
        console.log(`Removing ${card.title} with single copy`)
        deck = deck.filter(deckCard => deckCard.id !== card.id)
        deckLength = deck.length
      }
    }

    if (deckLength === 60) {
      return deck
    }

    return this.generateDeck(deck.map(card => card.ink), deck, deckType, triesRemaining)
  }

  removeCardsWithoutRequirements(deck) {
    const uniqueCardsInDeck = []
    for (const card of deck) {
      if (!uniqueCardsInDeck.includes(card)) {
        uniqueCardsInDeck.push(card)
      }
    }

    for (const card of uniqueCardsInDeck) {
      if (this.cardHasMissingRequirements(card, uniqueCardsInDeck)) {
        const requirements = {
          keywords: card.deckMeetsRequiredKeywords(deck),
          classifications: card.deckMeetsRequiredClassifications(deck),
          types: card.deckMeetsRequiredTypes(deck),
          cardNames: card.deckMeetsRequiredCardNames(deck),
          shiftRequirements: card.deckMeetsShiftRequirements(deck),
        }
        deck = deck.filter(deckCard => deckCard.id !== card.id)
      }
    }

    return deck
  }

  cardHasMissingRequirements(card, deck) {
    return !card.deckMeetsRequirements(deck)
  }
}
