document.addEventListener('DOMContentLoaded', () => {
    const possibleCards = []
    const cardsByCost = []

    const generateDeckButton = document.querySelector('[data-role=generator]')
    generateDeckButton.disabled = true

    const deckContainer = document.querySelector('[data-role=deck]')
    const addWeightToCardPossibilites = (deck, possibleCards) => {
        const weightedCards = []

        possibleCards.forEach(card => {
            // Prefer cards with inkwell
            card.weight = (card.inkwell ? 10 : 1) / possibleCards.length

            // Prefer cards with low cost
            card.weight *= (11 - card.cost) / 10

            // Prefer cards with keywords
            const keywords = card.keywords || []
            if (keywords.includes('Shift')) {
                card.weight *= 1.5
            }

            if (keywords.includes('Bodyguard')) {
                card.weight *= 1.3
            }

            if (keywords.includes('Rush')) {
                card.weight *= 1.3
            }

            if (keywords.includes('Evasive')) {
                card.weight *= 1.2
            }

            if (keywords.includes('Ward')) {
                card.weight *= 1.2
            }

            const types = card.types || []


            if (types.includes('Character')) {
                card.weight *= 1.3 // Prefer characters
            }

            if (types.includes('Action')) {
                card.weight *= 0.5

                if (types.includes('Song')) {
                    card.weight *= 0.5
                }
            }

            if (types.includes('Item')) {
                card.weight *= 0.2
            }

            if (types.includes('Location')) {
                card.weight *= 0.2
            }

            weightedCards.push(card)

        })

        // Add weight to cards with shift
        const cardsWithShift = []
        const cardsWithShiftAndShiftTarget = []
        const cardNames = []
        let containsMorp = false

        for (let card of deck) {
            const keywords = card.keywords || []
            if (keywords.includes('Shift')) {
                cardsWithShift.push(card.name)

                for (let existingCard of deck) {
                    if (card.name === existingCard.name && card.id !== existingCard.id) {
                        cardsWithShiftAndShiftTarget.push(card.name)
                    }
                }
            }

            if (card.id === 'crd_be70d689335140bdadcde5f5356e169d') {
                containsMorp = true
            }
        }

        for (let card of weightedCards) {
            const keywords = card.keywords || []

            if (containsMorp && keywords.includes('Shift')) {
                card.weight *= 1000000000
            } else if (cardsWithShift.includes(card.name) || keywords.includes('Shift') && cardNames.includes(card.name)) {
                card.weight *= 100

                if (!cardsWithShiftAndShiftTarget.includes(card.name)) {
                    card.weight *= 100000000 // We really want the shift target
                }
            }

        }

        // sort by weight
        weightedCards.sort((a, b) => b.weight - a.weight)

        return weightedCards
    }

    const pickRandomWeightedCard = (weightedCards) => {
        const totalWeight = weightedCards.reduce((acc, card) => acc + card.weight, 0)
        const randomWeight = Math.random() * totalWeight

        let currentWeight = 0
        for (let i = 0; i < weightedCards.length; i++) {
            const card = weightedCards[i]
            currentWeight += card.weight
            if (randomWeight < currentWeight) {
                return card
            }
        }

    }

    const generateDeck = () => {
        deckContainer.innerHTML = ''

        const deckSize = 60
        const deck = []
        console.log(`Generating deck of size ${deckSize}`)
        console.log(`Possible cards: ${possibleCards.length}`)

        // Get all possible card.ink
        const cardInk = possibleCards.map(card => card.ink)

        // Pick 2 random ink colors
        const inkColors = []
        while (inkColors.length < 2) {
            const randomInk = cardInk[Math.floor(Math.random() * cardInk.length)]
            inkColors.push(randomInk)
        }

        console.log(`Ink colors: ${inkColors}`)
        let cardOfInk = possibleCards.filter(card => inkColors.includes(card.ink))

        while (deck.length < deckSize) {
            const weightedCards = addWeightToCardPossibilites(deck, cardOfInk)
            const randomCard = pickRandomWeightedCard(weightedCards)
            const maxAmountOfCopies = Math.min(4, deckSize - deck.length)

            // Pick a random amount of copies for the card
            const weight1 = 0.05
            const weight2 = 0.15
            const weight3 = 0.3
            const weight4 = 0.5

            let chosenAmount = 5
            do {
                const randomAmount = Math.random()

                if (randomAmount < weight1) {
                    chosenAmount = 1
                } else if (randomAmount < weight2) {
                    chosenAmount = 2
                }
                else if (randomAmount < weight3) {
                    chosenAmount = 3
                }
                else if (randomAmount < weight4) {
                    chosenAmount = 4
                }
            } while (chosenAmount > maxAmountOfCopies)

            for (let i = 0; i < chosenAmount; i++) {

                deck.push(randomCard)
            }

            // Remove the card from the list of possible cards
            cardOfInk = cardOfInk.filter(card => card.id !== randomCard.id)
        }

        // Sort the deck by ink, then cost
        deck.sort((a, b) => {
            if (a.ink < b.ink) {
                return -1
            } else if (a.ink > b.ink) {
                return 1
            } else {
                return a.cost - b.cost
            }
        })

        // Add cards to [data-role=deck] element
        deck.forEach((card, index) => {
            const url = card.image_uris.digital.large
            const title = card.title ? card.name + ' - ' + card.title : card.name
            const id = card.id

            const cardHtml = `<div data-role="card-container" >
    <img src="${url}" alt="${title}" data-role="card" data-selected-card="${id}">
</div>`

            deckContainer.innerHTML += cardHtml
        })
    }


    generateDeckButton.addEventListener('click', () => {
        generateDeck()
    })

    const dialog = document.querySelector('[data-role=card-preview]')
    const closeButton = dialog.querySelector('[data-role=close]')
    const targetImg = dialog.querySelector('[data-role=card-preview] img')
    document.querySelector('[data-role=deck]').addEventListener('click', (event) => {
        const closestCard = event.target.closest('[data-role=card]')

        // Show card in modal
        if (closestCard) {
            const src = closestCard.src
            const alt = closestCard.alt

            targetImg.src = src
            targetImg.alt = alt

            dialog.showModal()
        }
    })

    closeButton.addEventListener('click', () => {
        dialog.close()
    })

    const asyncFetches = []
    for (let i = 0; i < 11; i++) {
        asyncFetches.push(
            fetch(`https://api.lorcast.com/v0/cards/search?q=cost:${i}`)
                .then(response => response.json())
                .then(data => {
                    console.log(`Fetched ${data.results.length} cards for cost ${i}`)
                    cardsByCost[i] = data.results
                })
        )
    }

    Promise.all(asyncFetches).then(() => {
        console.log('All cards fetched')

        cardsByCost.forEach((cards, cost) => {
            cards.forEach(card => {
                possibleCards.push(card)
            })
        })

        console.log(`Total cards fetched: ${possibleCards.length}`)
        generateDeckButton.disabled = false
    }).then(() => generateDeck())
})
