const singerRegex = /Singer (\d+)/
const bodyguardRegex = /Bodyguard \(This character may enter play exerted. An opposing character who challenges one of your characters must choose one with Bodyguard if able.\)/
const recklessRegex = /Reckless \(This character can[’'‘]t quest and must challenge each turn if able.\)/
const wardRegex = /Ward \(Opponents can[’'‘]t choose this character except to challenge.\)/
const evasiveRegex = /Evasive \(Only characters with Evasive can challenge this character.\)/
const resistRegex = /Resist \+(\d+) \(Damage dealt to this character is reduced by (\d+)\.\)/
const challengerRegex = /Challenger \+(\d+) \(While challenging, this character gets \+(\d) (?:\w+)?(?:{S})?\.\)/
const rushRegex = /Rush \(This character can challenge the turn they[’'‘]re played\.\)/

const shiftRegexes = [
  /Shift \d+ \(You may pay \d+ {i} to play this on top of one of your characters named .*\.\)/,
  /Shift: Discard an? .+ card \(You may discard an? .+ card to play this on top of one of your characters named .+\.\)/,
  /Shift: Discard \d+ cards \(You may discard \d+ cards to play this on top of one of your characters named .*\.\)/,
]

const keywordExplanationRegex = /\([^)]+\)/

const morphId = 'crd_be70d689335140bdadcde5f5356e169d'
const dalmatianPuppyId = 'crd_97f8be5e176144378d58823c6f9c29c7'

export default class Card {
  constructor(data) {
    this.id = data.id
    this.name = data.name
    this.version = data.version || null
    this.cost = data.cost || 0
    this.inkwell = data.inkwell || false
    this.ink = data.ink
    this.inks = data.inks || [data.ink]
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

    let parts = this.text.split('\n')
    this.sanitizedText = ''
    for (let i = 0; i < parts.length; i++) {
      // part starts with a keyword ignore it, else add it to the sanitized text
      const firstWord = parts[i].split(' ')[0]
      if (this.keywords.includes(firstWord)) {
        continue
      }

      this.sanitizedText += parts[i] + '\n'
    }

    // Remove all text between ()
    this.sanitizedText = this.sanitizedText.replace(/\([^)]+\)/g, '')

    // Remove all () from the text
    this.sanitizedText = this.sanitizedText.replace(/\(|\)/g, '')
    this.sanitizedText = this.sanitizedText.trim().toLowerCase()

    this.initialize()
  }

  initialize() {
    this.hasBodyguard = this.keywords.includes('Bodyguard')
    this.hasReckless = this.keywords.includes('Reckless')
    this.hasRush = this.keywords.includes('Rush')
    this.hasWard = this.keywords.includes('Ward')
    this.hasEvasive = this.keywords.includes('Evasive')
    this.hasResist = this.keywords.includes('Resist')
    this.hasChallenger = this.keywords.includes('Challenger')
    this.hasSinger = this.keywords.includes('Singer')
    this.hasShift = this.keywords.includes('Shift')

    if (this.hasShift) {
      let names = this.name.split('&').map(name => name.trim())
      this.requiredCardNames.push(...names)
    }
  }

  get title() {
    return this.name + (this.version ? `_${this.version}` : '')
  }

  get maxAmount() {
    return this.id === dalmatianPuppyId ? 60 : 4
  }

  get singCost() {
    if (this.hasSinger) {
      // Look for the Singer x text in the card's text
      const match = this.text.match(singerRegex)
      if (match) {
        return parseInt(match[1])
      }
    }

    return this.cost
  }

  get resistAmount() {
    if (this.hasResist) {
      // Look for the Resist +x text in the card's text
      const match = this.text.match(resistRegex)
      if (match) {
        return parseInt(match[1])
      }
    }

    return 0
  }

  get challengerAmount() {
    if (this.hasChallenger) {
      // Look for the Challenger +x text in the card's text
      const match = this.text.match(challengerRegex)
      if (match) {
        return parseInt(match[1])
      }
    }

    return 0
  }

  deckMeetsRequirements(deck) {
    const otherCardsInDeck = deck.filter(deckCard => deckCard.id !== this.id)

    return this.deckMeetsRequiredKeywords(otherCardsInDeck) &&
      this.deckMeetsRequiredClassifications(otherCardsInDeck) &&
      this.deckMeetsRequiredTypes(otherCardsInDeck) &&
      this.deckMeetsRequiredCardNames(otherCardsInDeck) &&
      this.deckMeetsShiftRequirements(otherCardsInDeck)
  }

  hasRequirementsForDeck(deck) {
    const uniqueDeckRequiredKeywords = []
    const uniqueDeckRequiredClassifications = []
    const uniqueDeckRequiredTypes = []
    const uniqueDeckRequiredCardNames = []

    deck.forEach(card => {
      uniqueDeckRequiredKeywords.push(...card.requiredKeywords)
      uniqueDeckRequiredClassifications.push(...card.requiredClassifications)
      uniqueDeckRequiredTypes.push(...card.requiredTypes)
      uniqueDeckRequiredCardNames.push(...card.requiredCardNames)
    })

    return uniqueDeckRequiredKeywords.some(keyword => this.keywords.includes(keyword)) ||
      uniqueDeckRequiredClassifications.some(classification => this.classifications.includes(classification)) ||
      uniqueDeckRequiredTypes.some(type => this.types.includes(type)) ||
      uniqueDeckRequiredCardNames.some(cardName => this.name.includes(cardName))
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
    if (!this.canShift) {
      return true
    }

    const morphInDeck = deck.filter(deckCard => deckCard.id === morphId).length > 0
    if (morphInDeck) {
      return true
    }

    const names = this.name.split('&').map(name => name.trim())

    const cardsWithSameNameButDifferentVersion = deck.filter(deckCard => names.includes(deckCard.name) && deckCard.id !== this.id)
    let foundCheaperVersion = false
    cardsWithSameNameButDifferentVersion.forEach(card => {
      if (card.cost < this.cost) {
        foundCheaperVersion = true
      }
    })

    return foundCheaperVersion
  }

  canShiftFrom(card) {
    if (!this.hasShift) {
      console.log(`Card ${this.title} can't shift`)
      return false
    }

    if (card.id === morphId) {
      return true
    }

    const ownNames = this.name.split('&').map(name => name.trim())
    const cardNames = card.name.split('&').map(name => name.trim())

    return ownNames.some(name => cardNames.includes(name))
  }
}
