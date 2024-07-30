import Card from "./Card";

export default class CardApi {
    async getCards() {
        const cost = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
        const cards = []

        const promises = cost.map(cost => this.getCardsByCost(cost))
        const results = await Promise.all(promises)

        results.forEach(cardsByCost => cards.push(...cardsByCost))

        return cards
    }

    async getCardsByCost(cost) {
        return fetch(`https://api.lorcast.com/v0/cards/search?q=cost:${cost}`)
            .then(response => response.json())
            .then(data => data.results)
            .then(cards => cards.map(card => new Card(card)))
    }
}