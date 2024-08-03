export default class DeckGenerator {
    constructor(cards, weightCalculator) {
        this.weightCalculator = weightCalculator
        this.cards = cards

        this.initializeCardRequirements()
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

    get keywords () {
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

    generateDeck(inks, deck = [], triesRemaining = 50) {
        console.log(`Generating deck, ${triesRemaining} tries remaining`)
        const cardsOfInk = this.cards.filter(card => inks.includes(card.ink))
        if (cardsOfInk.length === 0) {
            return []
        }
        do {
            let chosenCard = this.pickRandomCard(cardsOfInk, deck)
            deck.push(chosenCard)
        } while (!this.isDeckValid(deck))

        if (triesRemaining > 0) {
            triesRemaining--
            deck = this.validateAndRetry(deck, triesRemaining)
        }

        return deck
    }

    pickRandomCard(cards, deck) {
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

    validateAndRetry(deck, triesRemaining) {
        let deckLength = deck.length
        let previousDeckLength = deckLength = null
        do {
            previousDeckLength = deckLength
            deck = this.removeCardsWithoutRequirements(deck)
            deckLength = deck.length
        } while (deckLength !== previousDeckLength)

        if (deckLength === 60) {
            return deck
        }

        return this.generateDeck(deck.map(card => card.ink), deck, triesRemaining)
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
                console.log(`Deck is missing requirements, removing ${card.title}`)
                const requirements = {
                    keywords: card.deckMeetsRequiredKeywords(deck),
                    classifications: card.deckMeetsRequiredClassifications(deck),
                    types: card.deckMeetsRequiredTypes(deck),
                    cardNames: card.deckMeetsRequiredCardNames(deck),
                    shiftRequirements: card.deckMeetsShiftRequirements(deck),
                }
                console.table(requirements)
                deck = deck.filter(deckCard => deckCard.id !== card.id)
            }
        }

        return deck
    }

    cardHasMissingRequirements(card, deck) {
        return !card.deckMeetsRequirements(deck)
    }
}