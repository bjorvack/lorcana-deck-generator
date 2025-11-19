import './styles.css';
import TrainingManager from './scripts/TrainingManager';
import Chart from './scripts/Chart';
import CardSelector from './scripts/CardSelector';
import DeckRenderer from './scripts/DeckRenderer';
import InkSelector from './scripts/InkSelector';
import CardPreview from './scripts/CardPreview';

document.addEventListener('DOMContentLoaded', async () => {
    const manager = new TrainingManager();

    // UI Elements
    const startBtn = document.getElementById('start-training');
    const generateDeckBtn = document.getElementById('generate-deck-btn');
    const saveModelBtn = document.getElementById('save-model');
    const loadModelBtn = document.getElementById('load-model');
    const chartCanvas = document.querySelector('[data-role="chart"]');
    const legalOnlyCheckbox = document.getElementById('legal-only');

    const chart = new Chart(chartCanvas);
    let cardSelector;
    let deckRenderer;
    let inkSelector;
    let cardPreview;

    let currentPrediction = null;
    let currentDeck = []; // Store actual Card objects
    let currentInks = [];

    // Initialize CardPreview
    cardPreview = new CardPreview();

    // Initialize DeckRenderer
    const deckContainer = document.querySelector('[data-role="deck"]');
    deckRenderer = new DeckRenderer(deckContainer, {
        onRemove: (cardId) => {
            const index = currentDeck.findIndex(c => c.id === cardId);
            if (index !== -1) {
                currentDeck.splice(index, 1);
                updateDeckPreview();
                cardSelector.refresh();
            }
        },
        onAdd: () => cardSelector.show(),
        onCardClick: (card) => cardPreview.show(card.image, card.name),
        isEditable: true,
        showAddPlaceholder: true
    });

    // Initialize InkSelector
    inkSelector = new InkSelector(
        document.querySelector('[data-role="ink-selector"]'),
        {
            onChange: (inks) => {
                currentInks = inks;
                // Remove cards that don't match new inks
                // Filter currentDeck
                const validDeck = currentDeck.filter(card => {
                    return currentInks.includes(card.ink) || checkDualInks(card, currentInks);
                });

                if (validDeck.length !== currentDeck.length) {
                    currentDeck = validDeck;
                    updateDeckPreview();
                }

                if (cardSelector) cardSelector.refresh();
            }
        }
    );

    // Initial render to show placeholder
    updateDeckPreview();

    // Initialize Manager and fetch cards early for selector
    try {
        // We need cards to initialize the selector.
        // Manager fetches cards in startTraining or loadModel.
        // Let's force fetch here if not done.
        if (manager.cards.length === 0) {
            await manager.cardApi.getCards().then(cards => {
                manager.cards = cards;
                // Also init maps
                manager.cards.forEach((card, index) => {
                    const key = manager.getCardKey(card.name, card.version);
                    if (!manager.cardMap.has(key)) {
                        const id = manager.cardMap.size;
                        manager.cardMap.set(key, id);
                        manager.indexMap.set(id, card);
                    }
                });
            });
        }

        cardSelector = new CardSelector(
            manager.cards,
            document.querySelector('[data-role=card-select]'),
            (card) => addCardToDeck(card),
            {
                filter: (card) => {
                    // Filter by ink
                    if (currentInks.length > 0) {
                        const inkMatch = currentInks.includes(card.ink) || checkDualInks(card, currentInks);
                        if (!inkMatch) return false;
                    }

                    // Filter by count
                    const count = currentDeck.filter(c => c.id === card.id).length;
                    return count < 4;
                },
                renderButtonText: (card) => {
                    const count = currentDeck.filter(c => c.id === card.id).length;
                    return `Add Card (${count}/4)`;
                }
            }
        );

    } catch (e) {
        console.error("Failed to initialize cards:", e);
    }

    startBtn.addEventListener('click', async () => {
        startBtn.disabled = true;
        try {
            await manager.startTraining();
            generateDeckBtn.disabled = false;
        } catch (e) {
            console.error(e);
            manager.log(`Error: ${e.message}`);
        } finally {
            startBtn.disabled = false;
        }
    });

    saveModelBtn.addEventListener('click', async () => {
        await manager.saveModel();
    });

    loadModelBtn.addEventListener('click', async () => {
        await manager.loadModel();
        generateDeckBtn.disabled = false;
    });

    function checkDualInks(card, inks) {
        if (inks.length !== 2 || !card.inks) {
            return false;
        }
        return inks.includes(card.inks[0]) && inks.includes(card.inks[1]);
    }

    function addCardToDeck(card) {
        if (currentDeck.length >= 60) {
            alert("Deck is full (60 cards).");
            return;
        }
        // Check limit of 4
        const count = currentDeck.filter(c => c.id === card.id).length;
        if (count >= 4) {
            alert("Cannot add more than 4 copies of a card.");
            return;
        }

        currentDeck.push(card);
        updateDeckPreview();
        cardSelector.refresh(); // Update counts
    }

    function removeCard(cardId) {
        const index = currentDeck.findIndex(c => c.id === cardId);
        if (index !== -1) {
            currentDeck.splice(index, 1);
            updateDeckPreview();
            if (cardSelector) cardSelector.refresh();
        }
    }

    generateDeckBtn.addEventListener('click', async () => {
        generateDeckBtn.disabled = true;
        const legalOnly = legalOnlyCheckbox.checked;

        // Loop until 60 cards
        while (currentDeck.length < 60) {
            const names = currentDeck.map(c => c.version ? `${c.name} - ${c.version}` : c.name);
            const prediction = await manager.predict(names, legalOnly, currentInks);

            if (prediction && typeof prediction !== 'string') {
                currentDeck.push(prediction);
                updateDeckPreview();

                // Small delay to visualize progress
                await new Promise(r => setTimeout(r, 100));
            } else {
                manager.log("Model could not find a valid next card. Stopping generation.");
                break;
            }
        }
        generateDeckBtn.disabled = false;
    });

    function updateDeckPreview() {
        // Determine inks present for sorting order if not using selector, 
        // but we are using selector now.
        // Let's pass the selected inks to renderer for sorting preference
        deckRenderer.render(currentDeck, currentInks);


        // Update chart
        if (currentDeck.length > 0) {
            chart.renderChart(currentDeck);
        } else {
            chart.renderChart([]);
        }
    }
});
