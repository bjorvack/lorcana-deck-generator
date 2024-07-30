export default class WeightCalculator {
    baseWeight(card) {
        let weight = 10 - card.cost // Cheap cards are better
        weight += card.inkwell ? 5 : 0 // Inkwell cards are better
        weight += card.lore * 5 // Lore is good
        weight += card.keywords.length * 2 // Keywords have great effects
        weight += card.text !== '' ? 5 : 0 // Card's with text have effects, these are generally better

        return weight
    }

    calculateWeight(card, deck) {
        let weight = this.baseWeight(card)

        const keywordsInDeck = deck.map(card => card.keywords).flat() ?? []
        const classificationInDeck = deck.map(card => card.classifications).flat() ?? []
        const cardNamesInDeck = deck.map(card => card.name) ?? []

        // Handle Song cards
        const singersInDeck = deck.filter(card => card.keywords.includes('Singer'))
        if (card.types.includes('Song')) {
            // Songs are better if they have a Singer in the deck
            if (keywordsInDeck.includes('Singer')) {
                weight += 5
            }

            const singerCostValues = singersInDeck.map(card => card.singCost)
            const maxSingerCost = Math.max(...singerCostValues)
            if (card.singCost <= maxSingerCost) {
                weight += 5
            }
        }

        const songsInDeck = deck.filter(card => card.types.includes('Song'))
        // Handle Singer cards
        if (card.keywords.includes('Singer')) {
            // Singers are better if they have a Song in the deck
            if (keywordsInDeck.includes('Song')) {
                weight += 5
            }

            const songCostValues = songsInDeck.map(card => card.cost)
            songCostValues.forEach(songCost => {
                if (songCost <= card.cost) {
                    weight += 5
                }
            })
        }

        // Handle cards with "sing" in the text
        if (card.sanitizedText.includes('sing') && songsInDeck.length > 0) {
            weight += 5
        }

        // Handle cards with any keywords in the text
        if (keywordsInDeck.some(keyword => card.sanitizedText.includes(keyword.toLowerCase()))) {
            weight += 5
        }

        // Handle cards with any classification in the deck
        if (classificationInDeck.includes(card.classifications)) {
            weight += 5
        }

        // Handle cards with any card names in the deck
        if (cardNamesInDeck.some(cardName => card.sanitizedText.includes(cardName.toLowerCase()))) {
            weight += 5
        }

        // Handle shift cards
        if (card.keywords.includes('Shift') && cardNamesInDeck.includes(card.name)) {
            weight += 5
        }

        if (keywordsInDeck.includes('Shift')) {
            const shiftCardsInDeck = deck.filter(card => card.keywords.includes('Shift'))
            const shiftCardNamesInDeck = shiftCardsInDeck.map(card => card.name)

            if (shiftCardNamesInDeck.includes(card.name) || card.id === 'crd_be70d689335140bdadcde5f5356e169d') {
                weight += 5
            }
        }

        // Handle known good phrases

        // "draw a card" / "draw X cards
        if (card.sanitizedText.includes('draw a card') || card.sanitizedText.includes('draw x cards')) {
            weight += 5
        }

        // "banish"
        if (card.sanitizedText.includes('banish')) {
            weight += 5
        }

        // "return
        if (card.sanitizedText.includes('return')) {
            weight += 2
        }

        // "into your inkwell"
        if (card.sanitizedText.includes('into your inkwell')) {
            weight += 5
        }

        // "gain X lore"
        const match = card.sanitizedText.match(/gain (\d+) lore/)
        if (match) {
            weight += parseInt(match[1]) * 5
        }

        // If the card is in the deck, multiply the weight
        const cardInDeckCount = deck.filter(deckCard => deckCard.id === card.id).length
        if (cardInDeckCount > 0) {
            weight *= Math.pow(5 - cardInDeckCount, 2) // The more the card is in the deck, the less we want it
        }

        // If the card is 4 times in the deck, set the weight to 0
        if (cardInDeckCount >= 4) {
            weight = 0
        }

        return weight
    }
}