export default class DeckGenerator {
    constructor(cards, weightCalculator) {
        this.weightCalculator = weightCalculator
        this.cards = cards
    }

    generateDeck(inks) {
        const cardsOfInk = this.cards.filter(card => inks.includes(card.ink))
        if (cardsOfInk.length === 0) {
            return []
        }

        const deck = []
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

        return deck
    }

    pickRandomCard(cards, deck) {
        const weights = cards.map(card => {
            return {
                card,
                weight: this.weightCalculator.calculateWeight(card, deck)
            }
        })

        const pickableCards = weights.filter(weight => weight.weight > 0)
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
}