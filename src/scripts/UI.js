export default class UI {
  constructor(
    deckGenerator,
    loadingScreen,
    generateDeckButtons,
    testDeckButton,
    clearDeckButton,
    primaryInk,
    secondaryInk,
    deckContainer,
    dialogContainer,
    cardSelectContainer,
    chart
  ) {
    this.deck = []
    this.inks = []

    this.deckGenerator = deckGenerator
    this.loadingScreen = loadingScreen
    this.generateDeckButtons = generateDeckButtons
    this.testDeckButton = testDeckButton
    this.clearDeckButton = clearDeckButton
    this.primaryInk = primaryInk
    this.secondaryInk = secondaryInk
    this.deckContainer = deckContainer
    this.dialogContainer = dialogContainer
    this.cardSelectContainer = cardSelectContainer
    this.chart = chart

    this.init()
  }

  init() {
    this.addListeners()
    this.toggleInk()
    this.loadingScreen.close()
  }

  addListeners() {
    this.generateDeckButtons.forEach(button => {
      button.addEventListener('click', () => {
        this.loadingScreen.show()

        let deckType = 'default';
        switch (button.dataset.distribution) {
          case 'default':
            this.deckGenerator.useDefaultDistribution()
            break
          case 'aggro':
            deckType = 'aggro'
            this.deckGenerator.useAggroDistribution()
            break
        }


        this.deck = this.deckGenerator.generateDeck(this.inks, this.deck, deckType)

        this.renderDeck()
        this.addPickableCards()
        this.chart.renderChart(this.deck)

        setTimeout(() => this.loadingScreen.close(), 1000)
      })
    })

    this.clearDeckButton.addEventListener('click', () => {
      this.deck = []
      this.renderDeck()
      this.addPickableCards()
      this.chart.renderChart(this.deck)
    })

    this.primaryInk.addEventListener('change', this.toggleInk.bind(this))
    this.secondaryInk.addEventListener('change', this.toggleInk.bind(this))

    this.deckContainer.addEventListener('click', event => {
      const closestCard = event.target.closest('[data-role=card]')
      if (closestCard) {
        const img = this.dialogContainer.querySelector('img')
        img.src = closestCard.src
        img.alt = closestCard.alt

        this.dialogContainer.showModal()
      }
    })

    this.deckContainer.addEventListener('click', event => {
      const closestButton = event.target.closest('[data-role=remove-card]')
      if (closestButton) {
        const cardId = closestButton.dataset.cardId

        // remove the first card with the same id, keep the rest
        const index = this.deck.findIndex(card => card.id === cardId)
        if (index !== -1) {
          this.deck.splice(index, 1)
        }

        this.renderDeck()
        this.addPickableCards()
        this.chart.renderChart(this.deck)
      }
    })

    this.deckContainer.addEventListener('click', event => {
      const closestButton = event.target.closest('[data-role=add-card]')
      if (closestButton) {
        this.cardSelectContainer.showModal()
      }
    })

    this.dialogContainer.querySelector('[data-role=close]').addEventListener('click', () => {
      this.dialogContainer.close()
    })

    this.cardSelectContainer.querySelector('[data-role=close]').addEventListener('click', () => {
      this.cardSelectContainer.close()
    })

    this.cardSelectContainer.querySelector('[data-role=filter]').addEventListener('change', () => {
      this.addPickableCards()
    })

    this.cardSelectContainer.querySelector('[data-role=filter]').addEventListener('input', () => {
      this.addPickableCards()
    })

    this.cardSelectContainer.addEventListener('click', event => {
      const closestButton = event.target.closest('[data-role=add-card-to-deck]')
      if (closestButton) {
        const cardId = closestButton.dataset.card
        const card = this.deckGenerator.cards.find(card => card.id === cardId)
        this.deck.push(card)


        this.renderDeck()
        this.addPickableCards()
        this.chart.renderChart(this.deck)
        if (this.deck.length === 60) {
          this.cardSelectContainer.close()
        }
      }
    })

    this.testDeckButton.addEventListener('click', () => {
      window.open(this.inkTableLink, '_blank')
    })
  }

  toggleInk() {
    const inks = []

    let primaryInk = this.primaryInk.options[this.primaryInk.selectedIndex]
    let secondaryInk = this.secondaryInk.options[this.secondaryInk.selectedIndex]
    const possibleInks = ['Amber', 'Amethyst', 'Emerald', 'Ruby', 'Sapphire', 'Steel']

    if (primaryInk.value === 'Random') {
      const randomInk = possibleInks[Math.floor(Math.random() * possibleInks.length)]
      // Select the primary option where the value is the same as the random ink
      const option = Array.from(this.primaryInk.options).find(option => option.value === randomInk)
      option.selected = true

      primaryInk = option
    }

    if (secondaryInk.value === 'Random') {
      const randomInk = possibleInks[Math.floor(Math.random() * possibleInks.length)]
      // Select the secondary option where the value is the same as the random ink
      const option = Array.from(this.secondaryInk.options).find(option => option.value === randomInk)
      option.selected = true

      secondaryInk = option
    }

    inks.push(primaryInk.value)
    inks.push(secondaryInk.value)

    this.inks = inks.sort()
    this.removeCardsFromWrongInk()
    this.addPickableCards()
  }

  addPickableCards() {
    let possibleCards = this.getPossibleCards()
    const cardList = this.cardSelectContainer.querySelector('[data-role=card-list]')
    const search = this.cardSelectContainer.querySelector('[data-role=filter]').value.toLowerCase()

    if (search) {
      possibleCards = possibleCards.filter(card =>
        card.title.toLowerCase().includes(search) ||
        card.keywords.join(' ').toLowerCase().includes(search) ||
        card.types.join(' ').toLowerCase().includes(search) ||
        card.classifications.join(' ').toLowerCase().includes(search) ||
        card.text.toLowerCase().includes(search)
      )
    }

    cardList.innerHTML = ''
    possibleCards.forEach(card => {
      const cardCountInDeck = this.deck.filter(deckCard => deckCard.id === card.id).length

      const cardContainer = document.createElement('div')
      cardContainer.dataset.role = 'card-container'
      if (!card.deckMeetsRequirements(this.deck)) {
        //cardContainer.classList.add('missing-requirements')
      }
      cardList.appendChild(cardContainer)

      const image = document.createElement('img')
      image.src = card.image
      image.alt = card.title
      image.dataset.role = 'card'
      image.dataset.weight = this.deckGenerator.weightCalculator.calculateWeight(card, this.deck)
      image.dataset.sanitizedText = card.sanitizedText
      cardContainer.appendChild(image)

      const addButton = document.createElement('button')
      addButton.innerHTML = `Add card <small>(${cardCountInDeck}/4)</small>`
      addButton.dataset.role = 'add-card-to-deck'
      addButton.dataset.card = card.id
      cardContainer.appendChild(addButton)
    })
  }

  getPossibleCards() {
    return this.deckGenerator.cards
      .filter(card => this.inks.includes(card.ink))
      .filter(card => this.deck.filter(deckCard => deckCard.id === card.id).length < 4)
      .sort((a, b) => {
        if (a.ink !== b.ink) {
          return this.inks.indexOf(a.ink) - this.inks.indexOf(b.ink)
        }

        const typeOrder = ['Character', 'Action', 'Item', 'Location']
        if (a.types[0] !== b.types[0]) {
          return typeOrder.indexOf(a.types[0]) - typeOrder.indexOf(b.types[0])
        }

        if (a.cost !== b.cost) {
          return a.cost - b.cost
        }

        return a.title < b.title ? -1 : 1
      })
  }

  renderDeck() {
    this.deckContainer.innerHTML = ''

    this.deck.sort((a, b) => {
      if (a.ink !== b.ink) {
        return this.inks.indexOf(a.ink) - this.inks.indexOf(b.ink)
      }

      const typeOrder = ['Character', 'Action', 'Item', 'Location']
      if (a.types[0] !== b.types[0]) {
        return typeOrder.indexOf(a.types[0]) - typeOrder.indexOf(b.types[0])
      }

      if (a.cost !== b.cost) {
        return a.cost - b.cost
      }

      return a.title < b.title ? -1 : 1
    })
    this.deck.forEach(card => {
      this.addCard(card)
    })

    this.testDeckButton.classList.remove('hidden')
    this.generateDeckButtons.forEach(button => button.classList.add('hidden'))

    if (this.deck.length < 60) {
      const cardContainer = document.createElement('div')
      cardContainer.dataset.role = 'card-container'

      this.deckContainer.appendChild(cardContainer)

      const addButton = document.createElement('button')
      addButton.textContent = 'Add card'
      addButton.dataset.role = 'add-card'
      cardContainer.appendChild(addButton)

      this.testDeckButton.classList.add('hidden')
      this.generateDeckButtons.forEach(button => button.classList.remove('hidden'))
    }
  }

  addCard(card) {
    const cardContainer = document.createElement('div')
    cardContainer.dataset.role = 'card-container'
    if (!card.deckMeetsRequirements(this.deck)) {
      // cardContainer.classList.add('missing-requirements')
    }
    this.deckContainer.appendChild(cardContainer)

    const image = document.createElement('img')
    image.src = card.image
    image.alt = card.title
    image.dataset.role = 'card'
    image.dataset.selectedCard = card.id
    image.dataset.data = JSON.stringify(card)
    image.dataset.weight = this.deckGenerator.weightCalculator.calculateWeight(card, this.deck)
    cardContainer.appendChild(image)

    const removeButton = document.createElement('button')
    removeButton.textContent = 'X'
    removeButton.dataset.role = 'remove-card'
    removeButton.dataset.cardId = card.id

    cardContainer.appendChild(removeButton)
  }

  removeCardsFromWrongInk() {
    this.deck = this.deck.filter(card => this.inks.includes(card.ink))
    this.renderDeck()
    this.chart.renderChart(this.deck)
  }

  get inkTableLink() {
    const randomId = Math.random().toString(36).substring(7)
    let deckName = `Generated Deck: ${this.inks[0]} - ${this.inks[1]} - ${randomId}`
    // url encode deckName
    deckName = encodeURIComponent(deckName)
    let base64Id = ''
    const uniqueCardsInDeck = [...new Set(this.deck.map(card => card.title))]
    for (const card of uniqueCardsInDeck) {
      const amountOfCardsWithSameTitle = this.deck.filter(deckCard => deckCard.title === card).length
      base64Id += `${card}$${amountOfCardsWithSameTitle}|`
    }

    console.log(base64Id)
    console.log(btoa(base64Id))

    return `https://inktable.net/lor/import?svc=dreamborn&name=${deckName}&id=${btoa(base64Id)}`
  }
}
