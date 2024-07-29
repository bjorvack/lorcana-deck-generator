document.addEventListener('DOMContentLoaded', () => {
    const possibleCards = [];
    const cardsByCost = [];
    const generateDeckButton = document.querySelector('[data-role=generator]');
    const deckContainer = document.querySelector('[data-role=deck]');
    const dialog = document.querySelector('[data-role=card-preview]');
    const closeButton = dialog.querySelector('[data-role=close]');
    const targetImg = dialog.querySelector('[data-role=card-preview] img');

    generateDeckButton.disabled = true;

    const addWeightToCardPossibilities = (deck, possibleCards) => {
        const weightedCards = possibleCards.map(card => {
            // We want around 10% of the deck to be non-inkable cards
            card.weight = (card.inkwell ? 10 : 1) / possibleCards.length;

            // We want to prioritize low cost cards
            card.weight *= (11 - card.cost) / 10;

            const keywords = card.keywords || [];
            const types = card.types || [];

            // Cards with positive keywords are prioritized
            if (keywords.includes('Shift')) card.weight *= 1.5;
            if (keywords.includes('Bodyguard')) card.weight *= 1.3;
            if (keywords.includes('Rush')) card.weight *= 1.3;
            if (keywords.includes('Evasive')) card.weight *= 1.2;
            if (keywords.includes('Ward')) card.weight *= 1.2;

            // Our deck should have a good balance of card types
            if (types.includes('Character')) card.weight *= 1.3;
            if (types.includes('Action')) card.weight *= 0.5;
            if (types.includes('Song')) card.weight *= 0.5;
            if (types.includes('Item')) card.weight *= 0.2;
            if (types.includes('Location')) card.weight *= 0.2;

            return card;
        });

        // If we have cards with shift in the deck, we want to prioritize cards with shift and shift targets
        const cardsWithShift = deck.filter(card => (card.keywords || []).includes('Shift')).map(card => card.name);
        const cardsWithShiftAndShiftTarget = deck.filter(card => cardsWithShift.includes(card.name) && card.id !== card.id).map(card => card.name);
        const containsMorp = deck.some(card => card.id === 'crd_be70d689335140bdadcde5f5356e169d');

        weightedCards.forEach(card => {
            const keywords = card.keywords || [];
            if (containsMorp && keywords.includes('Shift')) {
                card.weight *= 1000000000; // If we have Morp, we want to pick Shift cards
            } else if (cardsWithShift.includes(card.name) || (keywords.includes('Shift') && cardsWithShift.includes(card.name))) {
                card.weight *= 100;
                if (!cardsWithShiftAndShiftTarget.includes(card.name)) card.weight *= 100000000; // If we have a Shift card, we want to pick Shift targets
            }
        });

        return weightedCards.sort((a, b) => b.weight - a.weight);
    };

    const pickRandomWeightedCard = (weightedCards) => {
        const totalWeight = weightedCards.reduce((acc, card) => acc + card.weight, 0);
        const randomWeight = Math.random() * totalWeight;
        let currentWeight = 0;

        for (const card of weightedCards) {
            currentWeight += card.weight;
            if (randomWeight < currentWeight) return card;
        }
    };

    const generateDeck = () => {
        deckContainer.innerHTML = '';
        const deckSize = 60;
        const deck = [];
        const cardInk = possibleCards.map(card => card.ink);
        const inkColors = [];

        while (inkColors.length < 2) {
            const randomInk = cardInk[Math.floor(Math.random() * cardInk.length)];
            inkColors.push(randomInk);
        }

        let cardOfInk = possibleCards.filter(card => inkColors.includes(card.ink));

        while (deck.length < deckSize) {
            const weightedCards = addWeightToCardPossibilities(deck, cardOfInk);
            const randomCard = pickRandomWeightedCard(weightedCards);
            const maxAmountOfCopies = Math.min(4, deckSize - deck.length);
            const weights = [0.05, 0.15, 0.3, 0.5];
            let chosenAmount = 5;

            do {
                const randomAmount = Math.random();
                chosenAmount = weights.findIndex(weight => randomAmount < weight) + 1;
            } while (chosenAmount > maxAmountOfCopies);

            for (let i = 0; i < chosenAmount; i++) deck.push(randomCard);
            cardOfInk = cardOfInk.filter(card => card.id !== randomCard.id);
        }

        deck.sort((a, b) => a.ink.localeCompare(b.ink) || a.cost - b.cost);

        deck.forEach(card => {
            const cardHtml = `<div data-role="card-container">
                <img src="${card.image_uris.digital.large}" alt="${card.name} - ${card.title || ''}" data-role="card" data-selected-card="${card.id}">
            </div>`;
            deckContainer.innerHTML += cardHtml;
        });
    };

    generateDeckButton.addEventListener('click', generateDeck);

    document.querySelector('[data-role=deck]').addEventListener('click', (event) => {
        const closestCard = event.target.closest('[data-role=card]');
        if (closestCard) {
            targetImg.src = closestCard.src;
            targetImg.alt = closestCard.alt;
            dialog.showModal();
        }
    });

    closeButton.addEventListener('click', () => dialog.close());

    const asyncFetches = Array.from({ length: 11 }, (_, i) =>
        fetch(`https://api.lorcast.com/v0/cards/search?q=cost:${i}`)
            .then(response => response.json())
            .then(data => {
                cardsByCost[i] = data.results;
            })
    );

    Promise.all(asyncFetches).then(() => {
        cardsByCost.flat().forEach(card => possibleCards.push(card));
        generateDeckButton.disabled = false;
    }).then(generateDeck);
});