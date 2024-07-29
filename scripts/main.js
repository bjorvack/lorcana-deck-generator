document.addEventListener('DOMContentLoaded', () => {
    const possibleCards = [];
    const cardsByCost = [];
    const classifications = ['Action', 'Character', 'Item', 'Location', 'Song'];
    const generateDeckButton = document.querySelector('[data-role=generator]');
    const deckContainer = document.querySelector('[data-role=deck]');
    const dialog = document.querySelector('[data-role=card-preview]');
    const closeButton = dialog.querySelector('[data-role=close]');
    const targetImg = dialog.querySelector('[data-role=card-preview] img');
    const chartContainer = document.querySelector('[data-role=chart]');

    generateDeckButton.disabled = true;

    const addWeightToCardPossibilities = (deck, possibleCards) => {
        const uniqueCardNames = deck.map(card => card.name);
        const inkCount = {
            Amber: 0,
            Amethyst: 0,
            Emerald: 0,
            Ruby: 0,
            Sapphire: 0,
            Steel: 0,
        }

        deck.forEach(card => {
            inkCount[card.ink] += 1;
        })

        const inkWithHighestCount = Object.keys(inkCount).reduce((a, b) => inkCount[a] > inkCount[b] ? a : b);

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
            if (keywords.includes('Singer')) card.weight *= 1.2;

            // Our deck should have a good balance of card types
            if (types.includes('Character')) card.weight *= 1.3;
            if (types.includes('Action')) card.weight *= 0.5;
            if (types.includes('Song')) card.weight *= 0.5;
            if (types.includes('Item')) card.weight *= 0.2;
            if (types.includes('Location')) card.weight *= 0.2;

            if (card.ink === inkWithHighestCount) {
                card.weight *= 0.5;
            }

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

        const classificationsInCardText = [];
        deck.forEach(card => {
            classifications.forEach(classification => {
                if (card.text && card.text.includes(classification) && !classificationsInCardText.includes(classification)) {
                    classificationsInCardText.push(classification);
                }
            });
        });

        weightedCards.forEach(card => {
            const cardClassifications = card.classifications || [];
            const cardTypes = card.types || [];
            const types = [...cardClassifications, ...cardTypes];

            types.forEach(classification => {
                if (classificationsInCardText.includes(classification)) card.weight *= 50000;
            });
        });

        weightedCards.forEach(card => {
            const foundDependency = uniqueCardNames.some(name => card.text && card.text.includes(name) && card.name !== name);
            if (foundDependency) card.weight *= 2000;
        });

        const cardsWithSinger = deck.filter(card => (card.keywords || []).includes('Singer')).map(card => card.cost);
        if (cardsWithSinger.length > 0) {
            weightedCards.forEach(card => {
                if (card.type.includes('Song')) {
                    card.weight *= 2000;
                }
            })
        }

        return weightedCards.sort((a, b) => b.weight - a.weight);
    };

    const selectRandomInk = () => {
        const checkboxes = document.querySelectorAll('input[data-role=ink]');

        // uncheck all checkboxes
        checkboxes.forEach(checkbox => checkbox.checked = false);

        // select 2 random checkboxes
        const randomInks = [];
        while (randomInks.length < 2) {
            const randomInk = checkboxes[Math.floor(Math.random() * checkboxes.length)];
            if (!randomInks.includes(randomInk)) {
                randomInk.checked = true;
                randomInks.push(randomInk);
            }
        }

        toggleInkCheckboxes()
    }

    const toggleInkCheckboxes = () => {
        // Enable all checkboxes
        const checkboxes = document.querySelectorAll('input[data-role=ink]');
        checkboxes.forEach(checkbox => checkbox.disabled = false);

        // Count the checked checkboxes
        const checkedCheckboxes = document.querySelectorAll('input[data-role=ink]:checked');
        const checkedCheckboxesCount = checkedCheckboxes.length;

        if (checkedCheckboxesCount >= 2) {
            // Disable all unchecked checkboxes
            const uncheckedCheckboxes = document.querySelectorAll('input[data-role=ink]:not(:checked)');
            uncheckedCheckboxes.forEach(checkbox => checkbox.disabled = true);
        }
    }
    document.querySelectorAll('[data-role=ink]').forEach(checkbox => {
        checkbox.addEventListener('click', toggleInkCheckboxes)
    })

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

        const checkedInkCount = document.querySelectorAll('input[data-role=ink]:checked').length;
        if (checkedInkCount === 0) {
            selectRandomInk()
        }

        const allowUnreleasedCards = document.querySelector('input[data-role=unreleased]').checked;
        const cardInk = Array.from(document.querySelectorAll('input[data-role=ink]:checked')).map(ink => ink.value);
        let cardOfInk = possibleCards.filter(
            card => {
                if (allowUnreleasedCards) return cardInk.includes(card.ink);

                return cardInk.includes(card.ink) && card.legalities.core === 'legal';
            }
        );

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

        generateChartForDeck(deck);
    };

    const generateChartForDeck = (deck) => {
        if (chartContainer.chart) {
            chartContainer.chart.destroy()
        }

        const inkColors = []
        deck.forEach(card => {
            if (!inkColors.includes(card.ink)) inkColors.push(card.ink)
        })

        const data = []
        inkColors.forEach(ink => {
            data.push({
                label: `Character ${ink}`,
                data: countCardsByCostAndType(deck, 'Character', ink)
            })

            data.push({
                label: `Action ${ink}`,
                data: countCardsByCostAndType(deck, 'Action', ink)
            })

            data.push({
                label: `Item ${ink}`,
                data: countCardsByCostAndType(deck, 'Item', ink)
            })

            data.push({
                label: `Location ${ink}`,
                data: countCardsByCostAndType(deck, 'Location', ink)
            })
        })

        const dataset = data.map((item) => {
            const inkName = item.label.split(' ')[1]
            let backgroundColor = ''
            let borderColor = ''
            switch (inkName) {
                case 'Amber':
                    borderColor = 'rgba(255, 215, 0, 0.2)'
                    backgroundColor = 'rgba(255, 215, 0, 1)'
                    break
                case 'Amethyst':
                    borderColor = 'rgba(153, 102, 204, 0.2)'
                    backgroundColor = 'rgba(153, 102, 204, 1)'
                    break
                case 'Emerald':
                    borderColor = 'rgba(0, 128, 0, 0.2)'
                    backgroundColor = 'rgba(0, 128, 0, 1)'
                    break
                case 'Ruby':
                    borderColor = 'rgba(220, 20, 60, 0.2)'
                    backgroundColor = 'rgba(220, 20, 60, 1)'
                    break
                case 'Sapphire':
                    borderColor = 'rgba(0, 0, 255, 0.2)'
                    backgroundColor = 'rgba(0, 0, 255, 1)'
                    break
                case 'Steel':
                    borderColor = 'rgba(192, 192, 192, 0.2)'
                    backgroundColor = 'rgba(192, 192, 192, 1)'
                    break
            }

            return {
                label: item.label,
                data: item.data,
                backgroundColor: backgroundColor,
                borderColor: borderColor,
            }
        })

        const chart = new Chart(
            chartContainer,
            {
                type: 'bar',
                data: {
                    labels: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
                    datasets: dataset
                },
                options: {
                    scales: {
                        x: {
                            stacked: true,
                        },
                        y: {
                            stacked: true
                        }
                    }
                }
            }
        )

        chartContainer.chart = chart
    }

    const countCardsByCostAndType = (deck, type, ink) => {
        let count = {
            0: 0,
            1: 0,
            2: 0,
            3: 0,
            4: 0,
            5: 0,
            6: 0,
            7: 0,
            8: 0,
            9: 0,
            10: 0
        }
        deck.forEach(card => {
          if (card.type.includes(type) && card.ink === ink) {
            count[card.cost] += 1
          }
        })

        return Object.values(count)
    }

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
        possibleCards.forEach(card => {
            const cardClassifications = card.classifications || [];
            cardClassifications.forEach(classification => {
                if (!classifications.includes(classification)) classifications.push(classification);
            });
        });
        generateDeckButton.disabled = false;
    })
        .then(selectRandomInk)
        .then(generateDeck);
});