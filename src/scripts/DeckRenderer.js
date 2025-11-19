export default class DeckRenderer {
    constructor(containerElement, options = {}) {
        this.container = containerElement;
        this.onRemove = options.onRemove || null;
        this.onAdd = options.onAdd || null;
        this.onCardClick = options.onCardClick || null;
        this.isEditable = options.isEditable !== undefined ? options.isEditable : true;
        this.showAddPlaceholder = options.showAddPlaceholder !== undefined ? options.showAddPlaceholder : false;

        // Keep a general options object for any other future options not explicitly destructured
        const { onRemove, onAdd, onCardClick, isEditable, showAddPlaceholder, ...otherOptions } = options;
        this.options = otherOptions;
    }

    render(deck, inks = []) {
        this.container.innerHTML = '';
        const sortedDeck = this._sortDeck(deck, inks);

        sortedDeck.forEach(card => {
            const cardElement = this._createCardElement(card);
            this.container.appendChild(cardElement);
        });

        if (this.showAddPlaceholder && deck.length < 60) {
            const placeholder = this._createAddPlaceholder();
            this.container.appendChild(placeholder);
        }
    }

    _sortDeck(deck, inks) {
        // Clone to avoid mutating original
        return [...deck].sort((a, b) => {
            if (a.ink !== b.ink) {
                // If inks are provided, sort by index in that array
                if (inks.length > 0) {
                    return inks.indexOf(a.ink) - inks.indexOf(b.ink);
                }
                return (a.ink || '').localeCompare(b.ink || '');
            }

            const typeOrder = ['Character', 'Action', 'Item', 'Location'];
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
    }

    _createCardElement(card) {
        const cardContainer = document.createElement('div');
        cardContainer.dataset.role = 'card-container';

        const img = document.createElement('img');
        img.src = card.image;
        img.alt = card.title || card.name;
        img.dataset.role = 'card';
        img.dataset.cardId = card.id; // Useful for click events

        if (this.onCardClick) {
            img.style.cursor = 'pointer';
            img.addEventListener('click', () => this.onCardClick(card));
        }

        cardContainer.appendChild(img);

        if (this.isEditable) {
            const removeButton = document.createElement('button');
            removeButton.textContent = 'X';
            removeButton.dataset.role = 'remove-card';
            removeButton.dataset.cardId = card.id;

            removeButton.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.onRemove) this.onRemove(card.id);
            });

            cardContainer.appendChild(removeButton);
        }

        return cardContainer;
    }

    _createAddPlaceholder() {
        const cardContainer = document.createElement('div');
        cardContainer.dataset.role = 'card-container';

        const addButton = document.createElement('button');
        addButton.textContent = 'Add card';
        addButton.dataset.role = 'add-card';

        addButton.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.onAdd) this.onAdd();
        });

        cardContainer.appendChild(addButton);
        return cardContainer;
    }
}
