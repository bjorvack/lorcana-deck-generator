import CardApi from "./scripts/CardApi";
import WeightCalculator from "./scripts/WeightCalculator";
import DeckGenerator from "./scripts/DeckGenerator";
import UI from "./scripts/UI";
import Chart from "./scripts/Chart";

import './styles.css'

// Wait for page to be loaded
document.addEventListener('DOMContentLoaded', async () => {
    const cardApi = new CardApi()
    const cards = await cardApi.getCards()
    const weightCalculator = new WeightCalculator()
    const deckGenerator = new DeckGenerator(cards, weightCalculator)
    const chart = new Chart(document.querySelector('[data-role=chart]'))
    const loadingScreenDialog = document.querySelector('[data-role=loading]')
    loadingScreenDialog.show()
    const ui = new UI(
        deckGenerator,
        loadingScreenDialog,
        document.querySelectorAll('[data-role=generator]'),
        document.querySelector('[data-role=test]'),
        document.querySelector('[data-role=clear]'),
        document.querySelector('#primaryInk'),
        document.querySelector('#secondaryInk'),
        document.querySelector('[data-role=deck]'),
        document.querySelector('[data-role=card-preview]'),
        document.querySelector('[data-role=card-select]'),
        chart
    )
})