export default class CardSelector {
  constructor (cards, dialogElement, onCardSelected, options = {}) {
    this.cards = cards
    this.dialog = dialogElement
    this.onCardSelected = onCardSelected
    this.options = {
      filter: options.filter || (() => true),
      sort: options.sort || null,
      renderButtonText: options.renderButtonText || (() => 'Add Card'),
      ...options
    }

    this.cardList = this.dialog.querySelector('[data-role=card-list]')
    this.filterInput = this.dialog.querySelector('[data-role=filter]')
    this.closeBtn = this.dialog.querySelector('[data-role=close]')

    this.init()
  }

  init () {
    this.bindEvents()
  }

  bindEvents () {
    this.closeBtn.addEventListener('click', () => this.hide())

    this.filterInput.addEventListener('input', () => {
      this.renderList(this.filterInput.value)
    })

    this.cardList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-role=add-card-to-deck]')
      if (btn) {
        const cardId = btn.dataset.card
        const card = this.cards.find(c => c.id === cardId)
        if (card) {
          this.onCardSelected(card)
        }
      }
    })
  }

  show () {
    this.dialog.showModal()
    this.refresh()
    this.filterInput.value = ''
    this.filterInput.focus()
  }

  hide () {
    this.dialog.close()
  }

  refresh () {
    this.renderList(this.filterInput.value)
  }

  renderList (filterText) {
    const search = filterText.toLowerCase()

    // 1. Apply Base Filter (e.g. Ink)
    let filteredCards = this.cards.filter(this.options.filter)

    // 2. Apply Search Filter
    if (search) {
      filteredCards = filteredCards.filter(card =>
        (card.title || card.name).toLowerCase().includes(search) ||
                (card.keywords && card.keywords.join(' ').toLowerCase().includes(search)) ||
                (card.types && card.types.join(' ').toLowerCase().includes(search)) ||
                (card.text && card.text.toLowerCase().includes(search))
      )
    }

    // 3. Apply Sort
    if (this.options.sort) {
      filteredCards.sort(this.options.sort)
    }

    this.cardList.innerHTML = ''
    filteredCards.forEach(card => {
      const cardContainer = document.createElement('div')
      cardContainer.dataset.role = 'card-container'

      const img = document.createElement('img')
      img.src = card.image
      img.alt = card.title || card.name
      img.dataset.role = 'card'
      cardContainer.appendChild(img)

      const addBtn = document.createElement('button')
      const btnText = this.options.renderButtonText(card)
      addBtn.innerHTML = btnText
      addBtn.dataset.role = 'add-card-to-deck'
      addBtn.dataset.card = card.id

      if (btnText.includes('Max Reached')) {
        addBtn.disabled = true
        addBtn.classList.add('opacity-50', 'cursor-not-allowed')
      }

      cardContainer.appendChild(addBtn)

      this.cardList.appendChild(cardContainer)
    })
  }
}
