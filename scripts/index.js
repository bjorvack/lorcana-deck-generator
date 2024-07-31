import CardApi from "./CardApi";
import WeightCalculator from "./WeightCalculator";
import DeckGenerator from "./DeckGenerator";
import UI from "./UI";
import Chart from "./Chart";

// Wait for page to be loaded
document.addEventListener('DOMContentLoaded', async () => {
    const cardApi = new CardApi()
    const cards = await cardApi.getCards()
    const weightCalculator = new WeightCalculator()
    const deckGenerator = new DeckGenerator(cards, weightCalculator)
    const chart = new Chart(document.querySelector('[data-role=chart]'))
    const ui = new UI(
        deckGenerator,
        document.querySelector('[data-role=generator]'),
        document.querySelector('[data-role=clear]'),
        document.querySelector('#primaryInk'),
        document.querySelector('#secondaryInk'),
        document.querySelector('[data-role=deck]'),
        document.querySelector('[data-role=card-preview]'),
        document.querySelector('[data-role=card-select]'),
        chart
    )
})