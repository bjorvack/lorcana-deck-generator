export default class InkSelector {
    constructor(containerElement, options = {}) {
        this.container = containerElement;
        this.options = {
            onChange: options.onChange || (() => { }),
            defaultInks: options.defaultInks || [],
            ...options
        };

        this.inks = [
            { name: 'Amber', image: 'assets/COLOR_AMBER_RGB.png' },
            { name: 'Amethyst', image: 'assets/COLOR_AMETHYST_RGB.png' },
            { name: 'Emerald', image: 'assets/COLOR_EMERALD_RGB.png' },
            { name: 'Ruby', image: 'assets/COLOR_RUBY_RGB.png' },
            { name: 'Sapphire', image: 'assets/COLOR_SAPPHIRE_RGB.png' },
            { name: 'Steel', image: 'assets/COLOR_STEEL_RGB.png' }
        ];

        this.selectedInks = [];
        this.maxSelection = 2;

        this.render();
    }

    render() {
        this.container.innerHTML = `
            <div class="ink-selector-container mb-1">
                <h3 class="text-center" style="margin-bottom: var(--spacing-md);">Select Your Inks</h3>
                <div class="ink-selector-grid">
                    ${this.inks.map(ink => `
                        <label class="ink-checkbox" data-ink="${ink.name}">
                            <input type="checkbox" value="${ink.name}" data-role="ink-checkbox">
                            <div class="ink-checkbox-icon">
                                <img src="${ink.image}" alt="${ink.name}" />
                            </div>
                            <span class="ink-checkbox-label">${ink.name}</span>
                        </label>
                    `).join('')}
                </div>
            </div>
        `;

        this.checkboxes = this.container.querySelectorAll('[data-role="ink-checkbox"]');
        this.checkboxes.forEach(checkbox => {
            checkbox.addEventListener('change', (e) => this._handleCheckboxChange(e));
        });

        // Initialize with defaults or random selection
        if (this.options.defaultInks.length === 2) {
            this.options.defaultInks.forEach(inkName => {
                const checkbox = Array.from(this.checkboxes).find(cb => cb.value === inkName);
                if (checkbox) {
                    checkbox.checked = true;
                    this.selectedInks.push(inkName);
                }
            });
        } else {
            // Select 2 random inks
            this._selectRandomInks();
        }

        this._updateCheckboxStates();
        this._notifyChange();
    }

    _selectRandomInks() {
        const shuffled = [...this.inks].sort(() => Math.random() - 0.5);
        const selected = shuffled.slice(0, 2);

        selected.forEach(ink => {
            const checkbox = Array.from(this.checkboxes).find(cb => cb.value === ink.name);
            if (checkbox) {
                checkbox.checked = true;
                this.selectedInks.push(ink.name);
            }
        });
    }

    _handleCheckboxChange(event) {
        const checkbox = event.target;
        const inkName = checkbox.value;

        if (checkbox.checked) {
            // Add to selection if under max
            if (this.selectedInks.length < this.maxSelection) {
                this.selectedInks.push(inkName);
            } else {
                // Prevent checking if max reached
                checkbox.checked = false;
                return;
            }
        } else {
            // Remove from selection
            const index = this.selectedInks.indexOf(inkName);
            if (index > -1) {
                this.selectedInks.splice(index, 1);
            }
        }

        this._updateCheckboxStates();
        this._notifyChange();
    }

    _updateCheckboxStates() {
        const maxReached = this.selectedInks.length >= this.maxSelection;

        this.checkboxes.forEach(checkbox => {
            const label = checkbox.closest('.ink-checkbox');

            if (!checkbox.checked && maxReached) {
                checkbox.disabled = true;
                label.classList.add('disabled');
            } else {
                checkbox.disabled = false;
                label.classList.remove('disabled');
            }
        });
    }

    _notifyChange() {
        const sortedInks = [...this.selectedInks].sort();
        this.options.onChange(sortedInks);
    }

    getSelectedInks() {
        return [...this.selectedInks].sort();
    }
}
