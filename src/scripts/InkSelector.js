export default class InkSelector {
    constructor(containerElement, options = {}) {
        this.container = containerElement;
        this.options = {
            onChange: options.onChange || (() => { }),
            defaultInks: options.defaultInks || [],
            ...options
        };

        this.inks = ['Amber', 'Amethyst', 'Emerald', 'Ruby', 'Sapphire', 'Steel'];
        this.render();
    }

    render() {
        this.container.innerHTML = `
            <div class="inks mb-1">
                <div class="form-group">
                    <label for="primaryInk">Primary Ink</label>
                    <select name="primaryInk" data-role="primary-ink">
                        <option value="Random" selected>Random Ink</option>
                        ${this.inks.map(ink => `<option value="${ink}">${ink}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label for="secondaryInk">Secondary Ink</label>
                    <select name="secondaryInk" data-role="secondary-ink">
                        <option value="Random" selected>Random Ink</option>
                        ${this.inks.map(ink => `<option value="${ink}">${ink}</option>`).join('')}
                    </select>
                </div>
            </div>
        `;

        this.primarySelect = this.container.querySelector('[data-role="primary-ink"]');
        this.secondarySelect = this.container.querySelector('[data-role="secondary-ink"]');

        this.primarySelect.addEventListener('change', () => this._handleInkChange());
        this.secondarySelect.addEventListener('change', () => this._handleInkChange());

        // Trigger initial change to set random values if needed or defaults
        // If defaults provided, set them
        if (this.options.defaultInks.length === 2) {
            this._setInk(this.primarySelect, this.options.defaultInks[0]);
            this._setInk(this.secondarySelect, this.options.defaultInks[1]);
        }

        // We always trigger handleInkChange to ensure "Random" is resolved if selected
        this._handleInkChange();
    }

    _setInk(selectElement, value) {
        const option = Array.from(selectElement.options).find(opt => opt.value === value);
        if (option) {
            option.selected = true;
        }
    }

    _handleInkChange() {
        let primaryInk = this.primarySelect.value;
        let secondaryInk = this.secondarySelect.value;
        let changed = false;

        if (primaryInk === 'Random') {
            const randomInk = this.inks[Math.floor(Math.random() * this.inks.length)];
            this._setInk(this.primarySelect, randomInk);
            primaryInk = randomInk;
            changed = true;
        }

        if (secondaryInk === 'Random') {
            const randomInk = this.inks[Math.floor(Math.random() * this.inks.length)];
            this._setInk(this.secondarySelect, randomInk);
            secondaryInk = randomInk;
            changed = true;
        }

        const selectedInks = [primaryInk, secondaryInk].sort();
        this.options.onChange(selectedInks);
    }

    getSelectedInks() {
        return [this.primarySelect.value, this.secondarySelect.value].sort();
    }
}
