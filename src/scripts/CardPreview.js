export default class CardPreview {
  constructor () {
    this.dialog = document.querySelector('dialog[data-role="card-preview"]')

    if (!this.dialog) {
      this._createDialog()
    }

    this._bindEvents()
  }

  _createDialog () {
    this.dialog = document.createElement('dialog')
    this.dialog.dataset.role = 'card-preview'

    const closeBtn = document.createElement('button')
    closeBtn.dataset.role = 'close'
    closeBtn.innerHTML = '&times;'

    const img = document.createElement('img')
    img.alt = 'Card Preview'

    this.dialog.appendChild(closeBtn)
    this.dialog.appendChild(img)

    document.body.appendChild(this.dialog)
  }

  _bindEvents () {
    const closeBtn = this.dialog.querySelector('[data-role="close"]')
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.hide())
    }

    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) {
        this.hide()
      }
    })
  }

  show (imageSrc, altText) {
    const img = this.dialog.querySelector('img')
    if (img) {
      img.src = imageSrc
      img.alt = altText || 'Card Preview'
    }
    this.dialog.showModal()
  }

  hide () {
    this.dialog.close()
  }
}
