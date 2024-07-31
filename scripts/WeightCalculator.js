export default class WeightCalculator {
    constructor() {
        this.cardCostWeight = 10
        this.inkwellWeight = 1.2
        this.loreWeight = 2
        this.hasAbillityWeight = 0.5
        this.requiredCardsWeight = 2.1
    }
    baseWeight(card) {
        let weight = Math.max(Math.pow(this.cardCostWeight - card.cost, 2), 1) // Cheap cards are better
        weight *= (card.inkwell ? this.inkwellWeight : 1) // Inkwell cards are better
        weight *= card.lore > 0 ? Math.pow(this.loreWeight, card.lore) : 1 // Lore is good
        weight *= card.text !== '' ? (1 + this.hasAbillityWeight) : (1 - this.hasAbillityWeight) // Card's with text have effects, these are generally better

        if (card.types.includes('Character')) {
            weight *= 0.7
        }

        if (card.types.includes('Action')) {
            weight *= 0.2
        }

        if (card.types.includes('Item') || card.types.includes('Location')) {
            weight *= 0.05
        }

        return weight
    }

    calculateWeight(card, deck) {
        let weight = this.baseWeight(card)

        const cardNamesInDeck = deck.map(card => card.name) ?? []
        if (card.types.includes('Character') && cardNamesInDeck.includes(card.name)) {
            weight *= 25 // Make it more likely to add card with the same name (e.g. different versions)
        }

        const amountOfRequiredTypesInDeck = {
            'Song': deck.filter(deckCard => deckCard.types.includes('Song')).length,
            'Item': deck.filter(deckCard => deckCard.types.includes('Item')).length,
            'Location': deck.filter(deckCard => deckCard.types.includes('Location')).length,
            'Action': deck.filter(deckCard => deckCard.types.includes('Action')).length,
        }

        const amountOfSongsInDeck = deck.filter(deckCard => deckCard.types.includes('Song')).length
        if (card.types.includes('Song') && amountOfSongsInDeck < 8) {
            weight *= Math.pow(this.requiredCardsWeight, amountOfRequiredTypesInDeck['Song'])

            const singersInDeck = deck.filter(deckCard => deckCard.keywords.includes('Singer'))
            const songValues = singersInDeck.map(card => card.singCost)
            if (songValues.length > 0 && songValues.includes(card.cost)) {
                weight *= Math.pow((128 - amountOfSongsInDeck), this.requiredCardsWeight)
            }
        }

        const amountOfItemsInDeck = deck.filter(deckCard => deckCard.types.includes('Item')).length
        if (card.types.includes('Item') && amountOfItemsInDeck < 4) {
            weight *= Math.pow(this.requiredCardsWeight, amountOfRequiredTypesInDeck['Item'])
        }

        const amountOfLocationsInDeck = deck.filter(deckCard => deckCard.types.includes('Location')).length
        if (card.types.includes('Location') && amountOfLocationsInDeck < 6) {
            weight *= Math.pow(this.requiredCardsWeight, amountOfRequiredTypesInDeck['Location'])
        }

        const amountOfActionsInDeck = deck.filter(deckCard => deckCard.types.includes('Action')).length
        if (card.types.includes('Action') && amountOfActionsInDeck < 12) {
            weight *= Math.pow(this.requiredCardsWeight, amountOfRequiredTypesInDeck['Action'])
        }

        if (card.deckMeetsRequirements(deck)) {
            weight *= Math.pow(this.requiredCardsWeight, 2)
        }

        if (deck.length >= 45 && card.deckMeetsRequirements(deck)) {
            weight *= 0.000001
        }

        // Handle shift cards
        const morphInDeck = deck.filter(deckCard => deckCard.id === 'crd_be70d689335140bdadcde5f5356e169d').length > 0
        if (card.keywords.includes('Shift') && (cardNamesInDeck.includes(card.name) || morphInDeck)) {
            weight *= this.requiredCardsWeight
        }

        // Handle known good phrases
        // "draw a card" / "draw X cards
        if (card.sanitizedText.includes('draw a card') || card.sanitizedText.includes('draw x cards')) {
            weight *= 1.4
        }

        // "banish"
        if (card.sanitizedText.includes('banish')) {
            weight *= 1.3
        }

        // "return
        if (card.sanitizedText.includes('return')) {
            weight *= 1.1
        }

        // "into your inkwell"
        if (card.sanitizedText.includes('into your inkwell')) {
            weight *= 1.2
        }

        // "banish all"
        if (card.sanitizedText.includes('banish all')) {
            weight *= 20 // Banish all cards are very good
        }

        // "gain X lore"
        const match = card.sanitizedText.match(/gain (\d+) lore/)
        if (match) {
            weight += parseInt(match[1]) * 5
        }

        // If the card is in the deck, multiply the weight
        const cardInDeckCount = deck.filter(deckCard => deckCard.id === card.id).length
        if (cardInDeckCount > 0) {
            weight *= Math.pow((10 - cardInDeckCount), 2)
        }

        return weight
    }
}