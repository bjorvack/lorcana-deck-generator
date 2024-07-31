export default class UI {
    constructor(
        deckGenerator,
        generateDeckButton,
        primaryInk,
        secondaryInk,
        deckContainer,
        dialogContainer,
        chart
    ) {
        this.deck = []
        this.inks = []

        this.deckGenerator = deckGenerator
        this.generateDeckButton = generateDeckButton
        this.primaryInk = primaryInk
        this.secondaryInk = secondaryInk
        this.deckContainer = deckContainer
        this.dialogContainer = dialogContainer
        this.chart = chart

        this.init()
    }

    init() {
        this.addListeners()
        this.toggleInk()
    }

    addListeners() {
        this.generateDeckButton.addEventListener('click', () => {
            this.deck = this.deckGenerator.generateDeck(this.inks, this.deck)

            this.renderDeck()
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
                this.chart.renderChart(this.deck)
            }
        })

        this.dialogContainer.querySelector('[data-role=close]').addEventListener('click', () => {
            this.dialogContainer.close()
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
    }

    renderDeck() {
        this.deckContainer.innerHTML = ''
        this.deck.forEach(card => {
            this.addCard(card)
        })

        if (this.deck.length < 60) {
            const cardContainer = document.createElement('div')
            cardContainer.dataset.role = 'card-container'
            this.deckContainer.appendChild(cardContainer)

            const addButton = document.createElement('button')
            addButton.textContent = 'Add card'
            addButton.dataset.role = 'add-card'
            cardContainer.appendChild(addButton)
        }
    }

    addCard(card) {
        const cardContainer = document.createElement('div')
        cardContainer.dataset.role = 'card-container'
        this.deckContainer.appendChild(cardContainer)

        const image = document.createElement('img')
        image.src = card.image
        image.alt = card.title
        image.dataset.role = 'card'
        image.dataset.selectedCard = card.id
        image.dataset.data = JSON.stringify(card)
        image.dataset.weight = this.deckGenerator.weightCalculator.calculateWeight(card, this.deck)
        image.dataset.baseWeight = this.deckGenerator.weightCalculator.baseWeight(card)
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
}