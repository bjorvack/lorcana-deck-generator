export default class DeckGenerator {
    constructor(cards, weightCalculator) {
        this.weightCalculator = weightCalculator
        this.cards = cards

        this.initializeCardRequirements()
    }

    initializeCardRequirements() {
        for (const index in this.cards) {
            for (const keyword of this.keywords) {
                if (this.cards[index].sanitizedText.includes(keyword.toLowerCase())) {
                    this.cards[index].requiredKeywords.push(keyword)
                }
            }

            for (const classification of this.classifications) {
                if (this.cards[index].sanitizedText.includes(classification.toLowerCase())) {
                    this.cards[index].requiredClassifications.push(classification)
                }
            }

            for (const type of this.types) {
                if (type === 'Character') {
                    continue // Skip Character type, since they are almost always required
                }

                if (this.cards[index].sanitizedText.includes(type.toLowerCase())) {
                    this.cards[index].requiredTypes.push(type)
                }

                if (this.cards[index].keywords.includes('Singer') && type === 'Song') {
                    this.cards[index].requiredTypes.push(type)
                }

                if (this.cards[index].sanitizedText.includes('sing') && type === 'Song') {
                    this.cards[index].requiredTypes.push(type)
                }
            }

            for (const cardName of this.cardNames) {
                if (this.cards[index].sanitizedText.includes(` ${cardName.toLowerCase()}`)) {
                    this.cards[index].requiredCardNames.push(cardName)
                }

                if (this.cards[index].keywords.includes('Shift') && this.cards[index].name === cardName) {
                    this.cards[index].requiredCardNames.push(cardName)
                }

                // if name contains & split by & and check if both are in the text
                if (this.cards[index].keywords.includes('Shift') && this.cards[index].name.includes('&')) {
                    const cardNames = cardName.split('&').map(name => name.toLowerCase().trim())
                    if (cardNames.includes(cardName)) {
                        this.cards[index].requiredCardNames.push(cardName)
                    }
                }
            }
        }
    }

    get keywords () {
        // Get all unique keywords from the cards
        return [...new Set(this.cards.map(card => card.keywords).flat())]
    }

    get classifications () {
        // Get all unique classifications from the cards
        return [...new Set(this.cards.map(card => card.classifications).flat())]
    }

    get types () {
        // Get all unique types from the cards
        return [...new Set(this.cards.map(card => card.types).flat())]
    }

    get cardNames () {
        // Get all unique card names from the cards
        return [...new Set(this.cards.map(card => card.name))]
    }

    generateDeck(inks, deck = [], triesRemaining = 10) {
        const cardsOfInk = this.cards.filter(card => inks.includes(card.ink))
        if (cardsOfInk.length === 0) {
            return []
        }
        do {
            let chosenCard = this.pickRandomCard(cardsOfInk, deck)
            deck.push(chosenCard)
        } while (!this.isDeckValid(deck))

        // Sort the deck by ink > type[0] > cost > name
        deck.sort((a, b) => {
            if (a.ink !== b.ink) {
                return inks.indexOf(a.ink) - inks.indexOf(b.ink)
            }

            const typeOrder = ['Character', 'Action', 'Item', 'Location']
            if (a.types[0] !== b.types[0]) {
                return typeOrder.indexOf(a.types[0]) - typeOrder.indexOf(b.types[0])
            }

            if (a.cost !== b.cost) {
                return a.cost - b.cost
            }

            return a.name < b.name ? -1 : 1
        })

        if (triesRemaining > 0) {
            triesRemaining--
            deck = this.removeCardsWithoutRequirements(deck, triesRemaining)
        }

        return deck
    }

    pickRandomCard(cards, deck) {
        if (deck.length < 5) {
            const buildAroundTypes = ['Song', 'Shift', 'Bulk', 'Item']
            const randomBuildAroundType = buildAroundTypes[Math.floor(Math.random() * buildAroundTypes.length)]
            console.log(`Building around ${randomBuildAroundType}`)
            switch (randomBuildAroundType) {
                case 'Song':
                    const songsAndSingers = cards.filter(card => card.types.includes('Song') || card.keywords.includes('Singer'))
                    return songsAndSingers[Math.floor(Math.random() * songsAndSingers.length)]
                case 'Shift':
                    const shifts = cards.filter(card => card.keywords.includes('Shift'))
                    return shifts[Math.floor(Math.random() * shifts.length)]
                case 'Bulk':
                    const bulk = cards.filter(card => card.cost > 5)
                    return bulk[Math.floor(Math.random() * bulk.length)]
                case 'Item':
                    const items = cards.filter(card => card.types.includes('Item'))
                    return items[Math.floor(Math.random() * items.length)]
            }
        }

        const weights = cards.map(card => {
            return {
                card,
                weight: this.weightCalculator.calculateWeight(card, deck)
            }
        })

        let pickableCards = weights.filter(weight => weight.weight > 0)
        // if a card is 4 times in a deck remove it from the pickable cards
        pickableCards = pickableCards.filter(weight => {
            return deck.filter(deckCard => deckCard.id === weight.card.id).length < 4
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

    removeCardsWithoutRequirements(deck, triesRemaining) {
        const uniqueCardsInDeck = []
        const uniqueInksInDeck = [...new Set(deck.map(card => card.ink))]
        for (const card of deck) {
            if (!uniqueCardsInDeck.includes(card)) {
                uniqueCardsInDeck.push(card)
            }
        }

        for (const card of uniqueCardsInDeck) {
            if (this.cardHasMissingRequirements(card, uniqueCardsInDeck)) {
                console.log(`Deck is missing requirements, removing ${card.title}`)
                deck = deck.filter(deckCard => deckCard.id !== card.id)
            }
        }

        if (deck.length === 60) {
            return deck
        }

        // Remove 20% of the remaining cards, this is to prevent infinite loops
        const cardsToRemove = Math.ceil((60 - deck.length) * 0.2)
        for (let i = 0; i < cardsToRemove; i++) {
            console.log(`Removing random cards from deck`)
            deck = deck.filter((_, index) => index !== Math.floor(Math.random() * deck.length))
        }

        return this.generateDeck(uniqueInksInDeck, deck, triesRemaining)
    }

    cardHasMissingRequirements(card, deck) {
        const meetsRequirements = card.deckMeetsRequirements(deck)
        const missingShiftSource = this.shiftCardHasNoLowerCostCardsInDeck(card, deck)
        const singerHasNoSongToSing = this.singerHasNoSongToSing(card, deck)

        return !meetsRequirements ||
            missingShiftSource ||
            singerHasNoSongToSing
    }

    singerHasNoSongToSing(card, deck) {
        if (!card.keywords.includes('Singer')) {
            return false
        }

        const songsInDeck = deck.filter(deckCard => deckCard.types.includes('Song'))
        if (card.singCost >= 1) {
            return !songsInDeck.some(deckCard => deckCard.cost >= card.singCost)
        }

        return !songsInDeck.some(deckCard => deckCard.cost === card.singCost)
    }

    shiftCardHasNoLowerCostCardsInDeck(card, deck) {
        if (!card.keywords.includes('Shift')) {
            return false
        }

        const cardsWithSameName = deck.filter(deckCard => deckCard.name === card.name)
        return !cardsWithSameName.some(deckCard => deckCard.cost < card.cost)
    }
}