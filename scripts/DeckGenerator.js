export default class DeckGenerator {
    constructor(cards, weightCalculator) {
        this.weightCalculator = weightCalculator
        this.cards = cards
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

    generateDeck(inks, deck = []) {
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

            if (a.types[0] !== b.types[0]) {
                return a.types[0] < b.types[0] ? -1 : 1
            }

            if (a.cost !== b.cost) {
                return a.cost - b.cost
            }

            return a.name < b.name ? -1 : 1
        })

        deck = this.removeCardsWithoutRequirements(deck)

        return deck
    }

    pickRandomCard(cards, deck) {
        const weights = cards.map(card => {
            return {
                card,
                weight: this.weightCalculator.calculateWeight(card, deck)
            }
        })

        if (deck.length >= 50) {
            // Lower the weight off cards if they have missing requirements
            weights.forEach(weight => {
                if (this.cardHasMissingRequirements(weight.card, deck)) {
                    weight.weight /= 10
                }
            })
        }

        let pickableCards = weights.filter(weight => weight.weight > 0)

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

    removeCardsWithoutRequirements(deck) {
        const uniqueCardsInDeck = []
        const uniqueInksInDeck = [...new Set(deck.map(card => card.ink))]
        for (const card of deck) {
            if (!uniqueCardsInDeck.includes(card)) {
                uniqueCardsInDeck.push(card)
            }
        }

        for (const card of uniqueCardsInDeck) {
            if (this.cardHasMissingRequirements(card, uniqueCardsInDeck)) {
                deck.filter(deckCard => deckCard.id !== card.id)
            }
        }

        if (deck.length === 60) {
            return deck
        }

        if (deck.length > 50) {
            // remove 30% of the remaining cards at random
            const cardsToRemove = Math.floor(deck.length * 0.3)
            for (let i = 0; i < cardsToRemove; i++) {
                const randomIndex = Math.floor(Math.random() * deck.length)
                deck.splice(randomIndex, 1)
            }
        }

        return this.generateDeck(uniqueInksInDeck, deck)
    }

    cardHasMissingRequirements(card, deck) {
        return this.cardHasMissingKeywordsInDeck(card, deck) ||
            this.cardHasMissingClassificationInDeck(card, deck) ||
            this.cardHasMissingTypesInDeck(card, deck) ||
            this.cardHasMissingCardNamesInDeck(card, deck) ||
            this.shiftCardHasNoLowerCostCardsInDeck(card, deck)
    }

    shiftCardHasNoLowerCostCardsInDeck(card, deck) {
        if (!card.keywords.includes('Shift')) {
            return false
        }

        const cardsWithSameName = deck.filter(deckCard => deckCard.name === card.name)
        return cardsWithSameName.some(deckCard => deckCard.cost < card.cost)
    }

    cardHasMissingCardNamesInDeck(card, deck) {
        const cardNamesInDeck = deck.map(card => card.name) ?? []
        const foundCardNames = []
        for (const cardName of this.cardNames) {
            if (card.sanitizedText.includes(cardName.toLowerCase())) {
                foundCardNames.push(cardName)
            }
        }

        for (const cardName of foundCardNames) {
            if (!cardNamesInDeck.includes(cardName)) {
                return true
            }
        }

        return false
    }

    cardHasMissingTypesInDeck(card, deck) {
        const typesInDeck = deck.map(card => card.types).flat() ?? []
        const foundTypes = []
        for (const type of this.types) {
            if (card.sanitizedText.includes(type.toLowerCase())) {
                foundTypes.push(type)
            }
        }

        for (const type of foundTypes) {
            if (!typesInDeck.includes(type)) {
                return true
            }
        }

        return false
    }

    cardHasMissingClassificationInDeck(card, deck) {
        const classificationInDeck = deck.map(card => card.classifications).flat() ?? []
        const foundClassifications = []
        for (const classification of this.classifications) {
            if (card.sanitizedText.includes(classification.toLowerCase())) {
                foundClassifications.push(classification)
            }
        }

        for (const classification of foundClassifications) {
            if (!classificationInDeck.includes(classification)) {
                return true
            }
        }

        return false
    }

    cardHasMissingKeywordsInDeck(card, deck) {
        const keywordsInDeck = deck.map(card => card.keywords).flat() ?? []
        const foundKeywords = []
        for (const keyword of this.keywords) {
            if (card.sanitizedText.includes(keyword.toLowerCase())) {
                foundKeywords.push(keyword)
            }
        }

        for (const keyword of foundKeywords) {
            if (!keywordsInDeck.includes(keyword)) {
                return true
            }
        }

        return false
    }
}