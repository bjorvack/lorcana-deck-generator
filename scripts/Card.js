export default class Card {
    constructor(data) {
        this.id = data.id
        this.name = data.name
        this.version = data.version || null
        this.cost = data.cost || 0
        this.inkwell = data.inkwell || false
        this.ink = data.ink
        this.keywords = data.keywords || []
        this.types = data.type || []
        this.classifications = data.classifications || []
        this.text = data.text || ''
        this.image = data.image_uris?.digital?.large || ''
        this.lore = data.lore || 0
        this.strength = data.strength || 0
        this.willpower = data.willpower || 0

        this.requiredKeywords = []
        this.requiredClassifications = []
        this.requiredTypes = []
        this.requiredCardNames = []

        // Lowercase all letters between {} in the card's text
        this.text = this.text.replace(/{[^}]+}/g, match => match.toLowerCase())
    }

    get title() {
        return this.name + (this.version ? `_${this.version}` : '')
    }

    get singCost() {
        if (this.keywords.includes('Singer')) {
            // Look for the Singer x text in the card's text
            const match = this.text.match(/Singer (\d+)/)
            if (match) {
                return parseInt(match[1])
            }
        }

        return this.cost
    }

    get sanitizedText() {
        // Remove the "Singer x (This character counts as cost x to sing songs.)" text from the card's text
        let text = this.text.replace(/Singer (\d+) \(This character counts as cost \d+ to sing songs.\)/, '')

        // Remove "(A character with cost x or more can {E} to sing this song for free.)"
        text = text.replace(/\(A character with cost \d+ or more can {E} to sing this song for free.\)/, '')

        // Remove "Rush (This character can challenge the turn they're played.)"
        text = text.replace(/Rush \(This character can challenge the turn they're played.\)/, '')

        // Remove "Bodyguard (This character may enter play exerted. An opposing character who challenges one of your characters must choose one with Bodyguard if able.)"
        text = text.replace(/Bodyguard \(This character may enter play exerted. An opposing character who challenges one of your characters must choose one with Bodyguard if able.\)/, '')

        // Remove "Ward (Opponents can't choose this character except to challenge.)"
        text = text.replace(/Ward \(Opponents can't choose this character except to challenge.\)/, '')

        // Remove "Evasive (Only characters with Evasive can challenge this character.)"
        text = text.replace(/Evasive \(Only characters with Evasive can challenge this character.\)/, '')

        // Remove "Challenger +x (While challenging, this character gets +x {S}.)"
        text = text.replace(/Challenger \+\d+ \(While challenging, this character gets \+\d+ {S}.\)/, '')

        // Remove "Reckless (This character can't quest and must challenge each turn if able.)"
        text = text.replace(/Reckless \(This character can't quest and must challenge each turn if able.\)/, '')

        // Remove "Shift x (You may pay x {I} to play this on top of one of your characters named YYYYYYYYYY.)
        text = text.replace(/Shift \d+ \(You may pay \d+ {I} to play this on top of one of your characters named .*\.\)/, '')

        // Remove "Shift: Discard a(n) XXXXXXX card (You may discard a(n) XXXXXXX card to play this on top of one of your characters named YYYYYY.)"
        text = text.replace(/Shift: Discard a\(n\) .+ card \(You may discard a\(n\) .+ card to play this on top of one of your characters named .*\.\)/, '')

        // Remove "Shift: Discard 2 cards (You may discard 2 cards to play this on top of one of your characters named Flotsam or Jetsam.)"
        text = text.replace(/Shift: Discard \d+ cards \(You may discard \d+ cards to play this on top of one of your characters named .*\.\)/, '')

        // Remove "Resist +X (Damage dealt to this character is reduced by X.)
        text = text.replace(/Resist \+\d+ \(Damage dealt to this character is reduced by \d+.\)/, '')

        // Remove all capitalized words
        text = text.replace(/\b[A-Z]+\b(?:\s+[A-Z]+\b)*/g, '')

        return text.toLowerCase()
    }

    deckMeetsRequirements(deck) {
        const otherCardsInDeck = deck.filter(deckCard => deckCard.id !== this.id)

        return this.deckMeetsRequiredKeywords(otherCardsInDeck) &&
            this.deckMeetsRequiredClassifications(otherCardsInDeck) &&
            this.deckMeetsRequiredTypes(otherCardsInDeck) &&
            this.deckMeetsRequiredCardNames(otherCardsInDeck) &&
            this.deckMeetsShiftRequirements(otherCardsInDeck)
    }

    deckMeetsRequiredKeywords(deck) {
        if (this.requiredKeywords.length === 0) {
            return true
        }

        const keywordsInDeck = deck.map(card => card.keywords).flat()

        return this.requiredKeywords.every(keyword => keywordsInDeck.includes(keyword))
    }

    deckMeetsRequiredClassifications(deck) {
        if (this.requiredClassifications.length === 0) {
            return true
        }

        const classificationsInDeck = deck.map(card => card.classifications).flat()

        return this.requiredClassifications.some(classification => classificationsInDeck.includes(classification))
    }

    deckMeetsRequiredTypes(deck) {
        if (this.requiredTypes.length === 0) {
            return true
        }

        const typesInDeck = deck.map(card => card.types).flat()

        return this.requiredTypes.every(type => typesInDeck.includes(type))
    }

    deckMeetsRequiredCardNames(deck) {
        if (this.requiredCardNames.length === 0) {
            return true
        }

        const cardNamesInDeck = deck.map(card => card.name)

        return this.requiredCardNames.some(cardName => cardNamesInDeck.includes(cardName))
    }

    deckMeetsShiftRequirements(deck) {
        if (!this.keywords.includes('Shift')) {
            return true
        }

        const morphInDeck = deck.filter(deckCard => deckCard.id === 'crd_be70d689335140bdadcde5f5356e169d').length > 0
        if (morphInDeck) {
            return true
        }

        const cardsWithSameNameButDifferentVersion = deck.filter(deckCard => deckCard.name === this.name && deckCard.id !== this.id)
        let foundCheaperVersion = false
        cardsWithSameNameButDifferentVersion.forEach(card => {
            if (card.cost < this.cost) {
                foundCheaperVersion = true
            }
        })

        return foundCheaperVersion
    }
}