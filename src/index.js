import CardApi from './scripts/CardApi'
import WeightCalculator from './scripts/WeightCalculator'
import DeckGenerator from './scripts/DeckGenerator'
import UI from './scripts/UI'
import Chart from './scripts/Chart'

import './styles/main.css'

// Wait for page to be loaded
document.addEventListener('DOMContentLoaded', async () => {
  const cardApi = new CardApi()
  const cards = await cardApi.getCards()
  const weightCalculator = new WeightCalculator()
  const deckGenerator = new DeckGenerator(cards, weightCalculator)
  const chart = new Chart(document.querySelector('[data-role=chart]'))
  const loadingScreenDialog = document.querySelector('[data-role=loading]')

  console.log('Loading screen element:', loadingScreenDialog)

  // Show the loading dialog
  if (loadingScreenDialog) {
    loadingScreenDialog.showModal()
  }

  new UI( // eslint-disable-line no-new
    deckGenerator,
    loadingScreenDialog,
    document.querySelectorAll('[data-role=generator]'),
    document.querySelector('[data-role=test]'),
    document.querySelector('[data-role=clear]'),
    document.querySelector('[data-role=deck]'),
    document.querySelector('[data-role=card-preview]'),
    document.querySelector('[data-role=card-select]'),
    chart
  )
})
