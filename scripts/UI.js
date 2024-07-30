export default class UI {
    constructor(
        deckGenerator,
        generateDeckButton,
        inkToggles,
        deckContainer,
        dialogContainer,
        chart
    ) {
        this.deck = []
        this.inks = []

        this.deckGenerator = deckGenerator
        this.generateDeckButton = generateDeckButton
        this.inkToggles = inkToggles
        this.deckContainer = deckContainer
        this.dialogContainer = dialogContainer
        this.chart = chart

        this.init()
    }

    init() {
        this.addListeners()

        const randomInkIndices = new Set()
        while (randomInkIndices.size < 2) {
            randomInkIndices.add(Math.floor(Math.random() * this.inkToggles.length))
        }
        randomInkIndices.forEach(index => this.inkToggles[index].checked = true)
        this.toggleInk()
        this.generateDeckButton.click()
    }

    addListeners() {
        this.generateDeckButton.addEventListener('click', () => {
            this.deck = this.deckGenerator.generateDeck(this.inks)

            this.renderDeck()
            this.chart.renderChart(this.deck)
        })

        this.inkToggles.forEach(checkbox => {
            checkbox.addEventListener('click', this.toggleInk.bind(this))
        })

        this.deckContainer.addEventListener('click', event => {
            const closestCard = event.target.closest('[data-role=card]')
            if (closestCard) {
                const img = this.dialogContainer.querySelector('img')
                img.src = closestCard.src
                img.alt = closestCard.alt

                this.dialogContainer.showModal()
            }
        })

        this.dialogContainer.querySelector('[data-role=close]').addEventListener('click', () => {
            this.dialogContainer.close()
        })
    }

    toggleInk() {
        for (const checkbox of this.inkToggles) {
            checkbox.disabled = false
        }

        const checkedInkToggles = []
        for (const checkbox of this.inkToggles) {
            if (checkbox.checked) {
                checkedInkToggles.push(checkbox)
            }
        }
        this.inks = checkedInkToggles.map(checkbox => checkbox.value)

        if (checkedInkToggles.length >= 2) {
            for (const checkbox of this.inkToggles) {
                if (!checkbox.checked) {
                    checkbox.disabled = true
                }
            }
        }
    }

    renderDeck() {
        this.deckContainer.innerHTML = ''
        this.deck.forEach(card => {
            this.addCard(card)
        })
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
    }
}