import './styles.css';
import TrainingManager from './scripts/TrainingManager';
import Chart from './scripts/Chart';

document.addEventListener('DOMContentLoaded', () => {
    const manager = new TrainingManager();
    const startBtn = document.getElementById('start-training');
    const logDiv = document.getElementById('log');
    const predictBtn = document.getElementById('predict-btn');
    const input = document.getElementById('prediction-input');
    const output = document.getElementById('prediction-output');
    const addToDeckBtn = document.getElementById('add-to-deck-btn');
    const generateDeckBtn = document.getElementById('generate-deck-btn');
    const deckPreview = document.getElementById('deck-preview');

    const saveModelBtn = document.getElementById('save-model');
    const loadModelBtn = document.getElementById('load-model');
    const chartCanvas = document.querySelector('[data-role="chart"]');

    const chart = new Chart(chartCanvas);


    document.getElementById('start-training').addEventListener('click', async () => {
        const btn = document.getElementById('start-training');
        btn.disabled = true;
        try {
            await manager.startTraining();
            predictBtn.disabled = false;
            generateDeckBtn.disabled = false;
        } catch (e) {
            console.error(e);
            manager.log(`Error: ${e.message}`);
        } finally {
            btn.disabled = false;
        }
    });

    saveModelBtn.addEventListener('click', async () => {
        await manager.saveModel();
    });

    loadModelBtn.addEventListener('click', async () => {
        await manager.loadModel();
        predictBtn.disabled = false;
        generateDeckBtn.disabled = false;
    });

    let currentPrediction = null;
    let currentDeck = []; // Store actual Card objects

    // Sync input text with currentDeck
    function syncInputFromDeck() {
        const names = currentDeck.map(c => c.version ? `${c.name} - ${c.version}` : c.name);
        input.value = names.join(', ');
    }

    function syncDeckFromInput() {
        const text = input.value;
        if (!text) {
            currentDeck = [];
            return;
        }
        const cardNames = text.split(',').map(s => s.trim()).filter(s => s);
        currentDeck = [];
        cardNames.forEach(name => {
            const card = manager.getCardByName(name);
            if (card) {
                currentDeck.push(card);
            }
        });
    }

    const legalOnlyCheckbox = document.getElementById('legal-only');

    predictBtn.addEventListener('click', async () => {
        syncDeckFromInput();
        updateDeckPreview(); // Update preview based on parsed cards

        if (currentDeck.length === 0) return;

        // We need to pass indices or names to predict. 
        // Manager.predict takes names? No, it takes names in the previous implementation I wrote?
        // Let's check TrainingManager.predict signature.
        // It has `async predict(cardNames)`.
        // So we pass names.

        const names = currentDeck.map(c => c.version ? `${c.name} - ${c.version}` : c.name);
        const legalOnly = legalOnlyCheckbox.checked;
        const prediction = await manager.predict(names, legalOnly);

        if (prediction && typeof prediction !== 'string') {
            currentPrediction = prediction;
            const displayName = prediction.version ? `${prediction.name} (${prediction.version})` : prediction.name;
            output.innerHTML = `<strong>Suggested Card:</strong> ${displayName}`;
            addToDeckBtn.disabled = false;
        } else {
            currentPrediction = null;
            output.innerHTML = `<strong>Suggested Card:</strong> ${prediction || "Unknown"}`;
            addToDeckBtn.disabled = true;
        }
    });

    addToDeckBtn.addEventListener('click', () => {
        if (!currentPrediction) return;

        currentDeck.push(currentPrediction);
        syncInputFromDeck();
        updateDeckPreview();

        addToDeckBtn.disabled = true;
        output.innerHTML = '';
        currentPrediction = null;
    });

    generateDeckBtn.addEventListener('click', async () => {
        syncDeckFromInput();
        generateDeckBtn.disabled = true;
        const legalOnly = legalOnlyCheckbox.checked;

        // Loop until 60 cards
        while (currentDeck.length < 60) {
            const names = currentDeck.map(c => c.version ? `${c.name} - ${c.version}` : c.name);
            const prediction = await manager.predict(names, legalOnly);

            if (prediction && typeof prediction !== 'string') {
                currentDeck.push(prediction);
                syncInputFromDeck();
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

    input.addEventListener('input', () => {
        // When user types, we update the deck preview but we don't overwrite the input
        // We parse the input to get card objects
        const text = input.value;
        const cardNames = text.split(',').map(s => s.trim()).filter(s => s);
        const tempDeck = [];
        cardNames.forEach(name => {
            const card = manager.getCardByName(name);
            if (card) {
                tempDeck.push(card);
            }
        });
        // We don't update currentDeck yet? 
        // If we do, we might lose state if user is typing a name.
        // But for preview we need objects.
        // Let's just render what we can parse.
        renderDeck(tempDeck);
    });



    function updateDeckPreview() {
        renderDeck(currentDeck);
    }

    function renderDeck(deck) {
        deckPreview.innerHTML = '';

        // Sort deck
        // 1. Ink
        // 2. Type
        // 3. Cost
        // 4. Title

        // Determine inks present for sorting order
        const inks = [...new Set(deck.map(c => c.ink).filter(i => i))].sort();

        const sortedDeck = [...deck].sort((a, b) => {
            if (a.ink !== b.ink) {
                return inks.indexOf(a.ink) - inks.indexOf(b.ink);
            }
            const typeOrder = ['Character', 'Action', 'Item', 'Location'];
            // a.types is array, use first type
            const aType = a.types && a.types.length > 0 ? a.types[0] : '';
            const bType = b.types && b.types.length > 0 ? b.types[0] : '';

            if (aType !== bType) {
                return typeOrder.indexOf(aType) - typeOrder.indexOf(bType);
            }

            if (a.cost !== b.cost) {
                return a.cost - b.cost;
            }

            return (a.title || a.name).localeCompare(b.title || b.name);
        });

        sortedDeck.forEach((card, sortedIndex) => {
            // We need to map back to original index for removal?
            // Or just remove by ID? But we can have duplicates.
            // Remove by index in the *original* deck is tricky if we sort.
            // UI.js removes by finding index of card with same ID.
            // "remove the first card with the same id"

            const cardContainer = document.createElement('div');
            cardContainer.dataset.role = 'card-container';

            const img = document.createElement('img');
            img.src = card.image;
            img.alt = card.title || card.name;
            img.dataset.role = 'card';
            cardContainer.appendChild(img);

            const removeButton = document.createElement('button');
            removeButton.textContent = 'X';
            removeButton.dataset.role = 'remove-card';
            // We store the card ID to remove it
            removeButton.dataset.cardId = card.id;
            // But wait, if I have 2 Elsas, which one do I remove?
            // UI.js removes the first one found in the array.
            // We can do the same.

            cardContainer.appendChild(removeButton);
            deckPreview.appendChild(cardContainer);
        });

        // Update remove listener to use ID
        if (deck.length > 0) {
            chart.renderChart(deck);
        } else {
            chart.renderChart([]);
        }
    }

    // Update the remove listener to work with ID
    deckPreview.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-role="remove-card"]');
        if (btn) {
            syncDeckFromInput();
            const cardId = btn.dataset.cardId;
            const index = currentDeck.findIndex(c => c.id === cardId);
            if (index !== -1) {
                currentDeck.splice(index, 1);
                syncInputFromDeck();
                updateDeckPreview();
            }
            e.stopPropagation(); // Prevent bubbling
        }
    });
});
