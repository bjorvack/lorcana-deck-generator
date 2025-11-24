import DeckRenderer from "./DeckRenderer";
import CardSelector from "./CardSelector";
import InkSelector from "./InkSelector";
import CardPreview from "./CardPreview";

export default class UI {
  constructor(
    deckGenerator,
    loadingScreen,
    generateDeckButtons,
    testDeckButton,
    clearDeckButton,
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
    this.deckContainer = deckContainer
    this.dialogContainer = dialogContainer
    this.cardSelectContainer = cardSelectContainer
    this.chart = chart

    this.cardPreview = new CardPreview();

    // Initialize Components
    this.deckRenderer = new DeckRenderer(this.deckContainer, {
      onRemove: (cardId) => this.removeCard(cardId),
      onAdd: () => this.cardSelector.show(),
      onCardClick: (card) => this.cardPreview.show(card.image, card.name),
      isEditable: true,
      showAddPlaceholder: true
    });

    this.cardSelector = new CardSelector(
      this.deckGenerator.cards,
      this.cardSelectContainer,
      (card) => this.addCardToDeck(card),
      {
        filter: (card) => this.filterCard(card),
        sort: (a, b) => this.sortCards(a, b),
        renderButtonText: (card) => this.renderButtonText(card)
      }
    );

    this.inkSelector = new InkSelector(
      document.querySelector('[data-role="ink-selector"]'),
      {
        onChange: (inks) => this.updateInks(inks)
      }
    );

    this.init()
  }

  init() {
    console.log('Loading screen:', this.loadingScreen);
    this.addListeners()
    if (this.loadingScreen) {
        // set display to none after initialization
        this.loadingScreen.close()
        this.loadingScreen.style.display = 'none'
    }
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
        this.chart.renderChart(this.deck)

        setTimeout(() => this.loadingScreen.close(), 1000)
      })
    })

    this.clearDeckButton.addEventListener('click', () => {
      this.deck = []
      this.renderDeck()
      this.chart.renderChart(this.deck)
    })

    this.testDeckButton.addEventListener('click', () => {
      window.open(this.inkTableLink, '_blank')
    })
  }

  updateInks(inks) {
    this.inks = inks;
    this.removeCardsFromWrongInk();
    this.cardSelector.refresh();
  }

  // --- Card Selector Options ---

  filterCard(card) {
    // Check Inks
    const inkMatch = this.inks.includes(card.ink) || this.checkDualInks(card);
    if (!inkMatch) return false;

    // Check Limit
    const count = this.deck.filter(deckCard => deckCard.title === card.title).length;
    return count < card.maxAmount;
  }

  checkDualInks(card) {
    if (this.inks.length !== 2) {
      return false
    }
    return this.inks.includes(card.inks[0]) && this.inks.includes(card.inks[1])
  }

  sortCards(a, b) {
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
  }

  renderButtonText(card) {
    const count = this.deck.filter(deckCard => deckCard.title === card.title).length;
    if (count >= card.maxAmount) {
      return `Max Reached <small>(${count}/${card.maxAmount})</small>`;
    }
    return `Add card <small>(${count}/${card.maxAmount})</small>`;
  }

  // --- Actions ---

  addCardToDeck(card) {
    this.deck.push(card);
    this.renderDeck();
    this.cardSelector.refresh(); // Update counts
    this.chart.renderChart(this.deck);

    if (this.deck.length === 60) {
      this.cardSelector.hide();
    }
  }

  removeCard(cardId) {
    const index = this.deck.findIndex(card => card.id === cardId);
    if (index !== -1) {
      this.deck.splice(index, 1);
    }
    this.renderDeck();
    this.cardSelector.refresh(); // Update counts
    this.chart.renderChart(this.deck);
  }

  removeCardsFromWrongInk() {
    this.deck = this.deck.filter(card => this.inks.includes(card.ink))
    this.renderDeck()
    this.chart.renderChart(this.deck)
  }

  renderDeck() {
    this.deckRenderer.render(this.deck, this.inks);

    // Toggle buttons based on deck state
    this.testDeckButton.classList.remove('hidden')
    this.generateDeckButtons.forEach(button => button.classList.add('hidden'))

    if (this.deck.length < 60) {
      this.testDeckButton.classList.add('hidden')
      this.generateDeckButtons.forEach(button => button.classList.remove('hidden'))
    }
  }

  get inkTableLink() {
    const randomId = Math.random().toString(36).substring(7)
    let deckName = `Generated Deck: ${this.inks[0]} - ${this.inks[1]} - ${randomId}`
    deckName = encodeURIComponent(deckName)
    let base64Id = ''
    const uniqueCardsInDeck = [...new Set(this.deck.map(card => card.title))]
    for (const card of uniqueCardsInDeck) {
      const amountOfCardsWithSameTitle = this.deck.filter(deckCard => deckCard.title === card).length
      base64Id += `${card}$${amountOfCardsWithSameTitle}|`
    }

    return `https://inktable.net/lor/import?svc=dreamborn&name=${deckName}&id=${btoa(base64Id)}`
  }
}
