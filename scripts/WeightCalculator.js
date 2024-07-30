export default class WeightCalculator {
    baseWeight(card) {
        let weight = Math.pow(10 - card.cost, 5) // Cheap cards are better
        weight *= card.inkwell ? 1.2 : 1 // Inkwell cards are better
        weight *= (card.lore + 1) // Lore is good
        weight *= card.keywords.length * 1.2 // Keywords have great effects
        weight *= card.text !== '' ? 1.5 : 0.7 // Card's with text have effects, these are generally better

        return weight
    }

    calculateWeight(card, deck) {
        let weight = this.baseWeight(card)

        const keywordsInDeck = deck.map(card => card.keywords).flat() ?? []
        const cardNamesInDeck = deck.map(card => card.name) ?? []

        const costInDeck = deck.filter(deckCard => deckCard.cost === card.cost)
        if (costInDeck.length < 4 && card.cost < 3) {
            weight *= 1.5
        }

        if (deck.length < 15 && card.types.includes('Character')) {
            weight *= 0.00001
        }

        const amountOfRequiredTypesInDeck = {
            'Song': deck.filter(deckCard => deckCard.types.includes('Song')).length,
            'Item': deck.filter(deckCard => deckCard.types.includes('Item')).length,
            'Location': deck.filter(deckCard => deckCard.types.includes('Location')).length,
            'Action': deck.filter(deckCard => deckCard.types.includes('Action')).length,
        }

        if (card.types.includes('Song')) {
            weight *= Math.pow(4, amountOfRequiredTypesInDeck['Song'])
        }

        if (card.types.includes('Item')) {
            weight *= Math.pow(4, amountOfRequiredTypesInDeck['Item'])
        }

        if (card.types.includes('Location')) {
            weight *= Math.pow(4, amountOfRequiredTypesInDeck['Location'])
        }

        if (card.types.includes('Action')) {
            weight *= Math.pow(4, amountOfRequiredTypesInDeck['Action'])
        }

        // Handle Song cards
        const singersInDeck = deck.filter(card => card.keywords.includes('Singer'))
        if (card.types.includes('Song')) {
            // Songs are better if they have a Singer in the deck
            if (keywordsInDeck.includes('Singer')) {
                weight *= 1.5
            }

            const singerCostValues = singersInDeck.map(card => card.singCost)
            const maxSingerCost = Math.max(...singerCostValues)
            if (card.singCost <= maxSingerCost) {
                weight *= 2
            }
        }

        const songsInDeck = deck.filter(card => card.types.includes('Song'))
        // Handle Singer cards
        if (card.keywords.includes('Singer')) {
            // Singers are better if they have a Song in the deck
            if (keywordsInDeck.includes('Song')) {
                weight *= 20
            }

            const songCostValues = songsInDeck.map(card => card.cost)
            songCostValues.forEach(songCost => {
                if (songCost <= card.cost) {
                    weight *= 5
                }
            })
        }

        // Handle cards with "sing" in the text
        if (card.sanitizedText.includes('sing') && songsInDeck.length > 0) {
            weight *= 2.5
        }

        if (card.deckMeetsRequirements(deck)) {
            // Handle cards with any keywords in the text
            if (card.deckMeetsRequiredKeywords(deck) && card.requiredKeywords.length > 0) {
                weight *= 4
            }

            // Handle cards with any classification in the deck
            if (card.deckMeetsRequiredClassifications(deck) && card.requiredClassifications.length > 0) {
                weight *= 4
            }

            // Handle cards with any card names in the deck
            if (card.deckMeetsRequiredCardNames(deck) && card.requiredCardNames.length > 0) {
                weight *= 2
            }

            // Handle cards with any types in the deck
            if (card.deckMeetsRequiredTypes(deck) && card.requiredTypes.length > 0) {
                weight *= 2
            }
        }

        // Handle shift cards
        if (card.keywords.includes('Shift') && cardNamesInDeck.includes(card.name)) {
            weight *= 5
        }

        if (keywordsInDeck.includes('Shift')) {
            const shiftCardsInDeck = deck.filter(card => card.keywords.includes('Shift'))
            const shiftCardNamesInDeck = shiftCardsInDeck.map(card => card.name)
            const shiftCardsWithSameName = shiftCardsInDeck.filter(
                shiftCard => shiftCard.name === card.name || card.id === 'crd_be70d689335140bdadcde5f5356e169d'
            )

            if (shiftCardNamesInDeck.includes(card.name)) {
                weight *= 1.5 // We have a card with the same name as the shift target
            }

            // If the card has a lower cost than any shift card with the same name, increase the weight
            if (shiftCardsWithSameName.some(shiftCard => shiftCard.cost > card.cost)) {
                weight *= 5
            }
        }

        // Handle known good phrases
        // "draw a card" / "draw X cards
        if (card.sanitizedText.includes('draw a card') || card.sanitizedText.includes('draw x cards')) {
            weight *= 5
        }

        // "banish"
        if (card.sanitizedText.includes('banish')) {
            weight *= 5
        }

        // "return
        if (card.sanitizedText.includes('return')) {
            weight *= 2
        }

        // "into your inkwell"
        if (card.sanitizedText.includes('into your inkwell')) {
            weight *= 5
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

        // If the card is 4 times in the deck, set the weight to 0
        if (cardInDeckCount >= 4) {
            weight = 0
        }

        return weight
    }
}