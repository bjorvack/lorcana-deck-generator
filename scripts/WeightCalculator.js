export default class WeightCalculator {
    baseWeight(card) {
        let weight = Math.max(Math.pow(10 - card.cost, 2), 1) // Cheap cards are better
        weight *= (card.inkwell ? 1.2 : 1) // Inkwell cards are better
        weight *= card.lore > 0 ? Math.pow(2, card.lore) : 1 // Lore is good
        weight *= card.keywords.length > 0 ? card.keywords.length * 1.2 : 1 // Keywords have great effects
        weight *= card.text !== '' ? 1.5 : 0.7 // Card's with text have effects, these are generally better

        if (card.types.includes('Character')) {
            weight *= 1.5
        }

        if (card.types.includes('Action')) {
            weight *= 1.3
        }

        return Math.max(weight, 1)
    }

    calculateWeight(card, deck) {
        let weight = this.baseWeight(card)

        const keywordsInDeck = deck.map(card => card.keywords).flat() ?? []
        const cardNamesInDeck = deck.map(card => card.name) ?? []

        const costInDeck = deck.filter(deckCard => deckCard.cost === card.cost)
        if (costInDeck.length < 4 && card.cost < 3) {
            weight *= 1.5
        }

        const amountOfRequiredTypesInDeck = {
            'Song': deck.filter(deckCard => deckCard.types.includes('Song')).length,
            'Item': deck.filter(deckCard => deckCard.types.includes('Item')).length,
            'Location': deck.filter(deckCard => deckCard.types.includes('Location')).length,
            'Action': deck.filter(deckCard => deckCard.types.includes('Action')).length,
        }

        const amountOfSongsInDeck = deck.filter(deckCard => deckCard.types.includes('Song')).length
        if (card.types.includes('Song') && amountOfSongsInDeck < 8) {
            weight *= Math.pow(2.1, amountOfRequiredTypesInDeck['Song'])
        }

        const amountOfItemsInDeck = deck.filter(deckCard => deckCard.types.includes('Item')).length
        if (card.types.includes('Item') && amountOfItemsInDeck < 8) {
            weight *= Math.pow(2.1, amountOfRequiredTypesInDeck['Item'])
        }

        const amountOfLocationsInDeck = deck.filter(deckCard => deckCard.types.includes('Location')).length
        if (card.types.includes('Location') && amountOfLocationsInDeck < 8) {
            weight *= Math.pow(2.1, amountOfRequiredTypesInDeck['Location'])
        }

        const amountOfActionsInDeck = deck.filter(deckCard => deckCard.types.includes('Action')).length
        if (card.types.includes('Action') && amountOfActionsInDeck < 8) {
            weight *= Math.pow(2.1, amountOfRequiredTypesInDeck['Action'])
        }

        // Handle Singer cards
        if (card.keywords.includes('Singer')) {
            // Singers are better if they have a Song in the deck
            if (keywordsInDeck.includes('Song')) {
                weight *= 1.2
            }

            const songsInDeck = deck.filter(deckCard => deckCard.types.includes('Song'))
            const songCostValues = songsInDeck.map(card => card.cost)
            songCostValues.forEach(songCost => {
                if (songCost <= card.cost) {
                    weight *= 1.2
                }
            })
        }

        if (card.deckMeetsRequirements(deck)) {
            // Handle cards with any keywords in the text
            if (card.deckMeetsRequiredKeywords(deck) && card.requiredKeywords.length > 0) {
                weight *= 2.1
            }

            // Handle cards with any classification in the deck
            if (card.deckMeetsRequiredClassifications(deck) && card.requiredClassifications.length > 0) {
                weight *= 2.1
            }

            // Handle cards with any card names in the deck
            if (card.deckMeetsRequiredCardNames(deck) && card.requiredCardNames.length > 0) {
                weight *= 2.1
            }

            // Handle cards with any types in the deck
            if (card.deckMeetsRequiredTypes(deck) && card.requiredTypes.length > 0) {
                weight *= 2.1
            }
        }

        // Handle shift cards
        const morphInDeck = deck.filter(deckCard => deckCard.id === 'crd_be70d689335140bdadcde5f5356e169d').length > 0
        if (card.keywords.includes('Shift') && (cardNamesInDeck.includes(card.name) || morphInDeck)) {
            weight *= 1.2
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
            weight *= 100 // Banish all cards are very good
        }

        // "gain X lore"
        const match = card.sanitizedText.match(/gain (\d+) lore/)
        if (match) {
            weight += parseInt(match[1]) * 5
        }

        // If the card is in the deck, multiply the weight
        const cardInDeckCount = deck.filter(deckCard => deckCard.id === card.id).length
        if (cardInDeckCount > 0) {
            weight *= 30
        }

        return weight
    }
}