export default class WeightCalculator {
    constructor() {
        this.cardCostWeight = 10
        this.inkwellWeight = 1.2
        this.loreWeight = 2
        this.hasAbillityWeight = 1.5
        this.requiredCardsWeight = 2.1
    }
    baseWeight(card) {
        let weight = Math.max(Math.pow(this.cardCostWeight - card.cost, 2), 1) // Cheap cards are better
        weight *= (card.inkwell ? this.inkwellWeight : 1) // Inkwell cards are better
        weight *= card.lore > 0 ? Math.pow(this.loreWeight, card.lore) : 1 // Lore is good
        weight *= card.text !== '' ? (1 + this.hasAbillityWeight) : (1 - this.hasAbillityWeight) // Card's with text have effects, these are generally better

        if (card.types.includes('Character')) {
            weight *= 0.7

            if (card.sanitizedText.includes('This character can\'t {e} to sing songs.'.toLowerCase())) {
                weight *= 0.1 // Characters that can't sing are less good
            }
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

        const cardTitlesInDeck = deck.map(card => card.title) ?? []
        if (cardTitlesInDeck.includes(card.title)) {
            switch (cardTitlesInDeck.length) {
                case 1:
                    weight *= 80
                    break
                case 2:
                    weight *= 70
                    break
                case 3:
                    weight *= 60
                    break
                default:
                    weight *= 55
                    break
            }
        }

        const nameRequirementsInDeck = deck.map(card => card.requiredCardNames).flat() ?? []
        const amountOfRequiredNamesByName = {}
        nameRequirementsInDeck.forEach(name => {
            amountOfRequiredNamesByName[name] = amountOfRequiredNamesByName[name] + 1 || 1
        })

        if (nameRequirementsInDeck.includes(card.name)) {
            const countCardNameInDeck = deck.filter(deckCard => deckCard.name === card.name).length

            if (countCardNameInDeck === 0) {
                weight *= 10000 // If the specific card is required and not in the deck, make it very likely to add it
            }

            if (amountOfRequiredNamesByName[card.name] * 2 > countCardNameInDeck) {
                weight *= Math.pow(this.requiredCardsWeight, amountOfRequiredNamesByName[card.name])
            }
        }

        const amountOfRequiredTypesInDeck = {
            'Song': deck.filter(deckCard => deckCard.requiredTypes.includes('Song')).length,
            'Item': deck.filter(deckCard => deckCard.requiredTypes.includes('Item')).length,
            'Location': deck.filter(deckCard => deckCard.requiredTypes.includes('Location')).length,
            'Action': deck.filter(deckCard => deckCard.requiredTypes.includes('Action')).length,
        }

        const amountOfSongsInDeck = deck.filter(deckCard => deckCard.types.includes('Song')).length
        if (card.types.includes('Song') &&
            amountOfRequiredTypesInDeck['Song'] > 0 &&
            amountOfSongsInDeck < 8
        ) {
            weight *= Math.pow(this.requiredCardsWeight, amountOfRequiredTypesInDeck['Song'])
        }

        const singersInDeck = deck.filter(deckCard => deckCard.keywords.includes('Singer'))
        if (card.types.includes('Song') &&
            Math.min(singersInDeck.length * 2, 12) > amountOfSongsInDeck
        ) {
            const amountOfSingersBySongCost = {}
            singersInDeck.forEach(card => {
                amountOfSingersBySongCost[card.cost] = amountOfSingersBySongCost[card.cost] + 1 || 1
            })

            const amountOfSongsByCost = {}
            deck.filter(deckCard => deckCard.types.includes('Song')).forEach(card => {
                amountOfSongsByCost[card.cost] = amountOfSongsByCost[card.cost] + 1 || 1
            })

            // Make sure that the keys are the same
            Object.keys(amountOfSingersBySongCost).forEach(key => {
                if (!amountOfSongsByCost[key]) {
                    amountOfSongsByCost[key] = 0
                }
            })

            // The song has a cost equal to the cost of a singer
            if (amountOfSingersBySongCost[card.cost] > 0 && amountOfSongsByCost[card.cost] < amountOfSingersBySongCost[card.cost]) {
                weight *= this.requiredCardsWeight * 5 // Make it very likely to add a song with the same cost as a singer
            }

            const singerCosts = Object.keys(amountOfSingersBySongCost)
            // If there is a singer cost lower than the song cost
            if (singerCosts.some(cost => cost < card.cost)) {
                weight *= Math.max(this.requiredCardsWeight * 0.5, 1.1) // Make it slightly more likely to add a song with a lower cost than a singer
            }

            if (card.text.includes('Sing Together')) {
                weight *= this.requiredCardsWeight // Make it more likely to add a song with the Sing Together ability
            }
        }

        const amountOfItemsInDeck = deck.filter(deckCard => deckCard.types.includes('Item')).length
        if (card.types.includes('Item') &&
            amountOfRequiredTypesInDeck['Item'] > 0 &&
            amountOfItemsInDeck < 4) {
            weight *= Math.pow(this.requiredCardsWeight, amountOfRequiredTypesInDeck['Item'])
        }

        const amountOfLocationsInDeck = deck.filter(deckCard => deckCard.types.includes('Location')).length
        if (card.types.includes('Location') &&
            amountOfRequiredTypesInDeck['Location'] > 0 &&
            amountOfLocationsInDeck < 6
        ) {
            weight *= Math.pow(this.requiredCardsWeight, amountOfRequiredTypesInDeck['Location'])
        }

        const amountOfActionsInDeck = deck.filter(deckCard => deckCard.types.includes('Action')).length
        if (card.types.includes('Action') &&
            amountOfRequiredTypesInDeck['Action'] > 0 &&
            amountOfActionsInDeck < 12
        ) {
            weight *= Math.pow(this.requiredCardsWeight, amountOfRequiredTypesInDeck['Action'])
        }

        if (card.deckMeetsRequirements(deck)) {
            weight *= Math.pow(this.requiredCardsWeight, 2)
        }

        if (deck.length >= 40 && !card.deckMeetsRequirements(deck)) {
            weight *= 0.001
        }

        const cardsThatCanShift = deck.filter(deckCard => deckCard.canShift)
        // Add cards to shift from
        const uniqueShiftsInDeck = [...new Set(cardsThatCanShift.map(card => card.name))]
        uniqueShiftsInDeck.forEach(shiftCard => {
            let  names = [shiftCard]
            if (shiftCard.includes('&')) {
                names = shiftCard.split('&').map(name => name.trim())
            }

            if (names.includes(card.name)) {
                weight *= this.requiredCardsWeight
            }
        })

        // Add new shift targets
        if (card.canShift && card.deckMeetsShiftRequirements(deck)) {
            weight *= Math.pow(this.requiredCardsWeight, 20)
        }

        // Handle known good phrases
        // "draw a card"
        if (card.sanitizedText.includes('draw a card')) {
            weight *= 1.5
        }

        // "draw(s) X cards"
        const drawMatch = card.sanitizedText.match(/draws? (\d+) cards/)
        if (drawMatch) {
            weight *= Math.pow(parseInt(drawMatch[1]), 1.5)
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
            weight *= parseInt(match[1]) * 1.2
        }

        return weight
    }
}