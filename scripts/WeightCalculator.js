export default class WeightCalculator {
    constructor() {
        this.inkwellWeight = 0.2;
        this.hasAbilityWeight = 0.1;
        this.requiredCardsPunishment = 0.1;
    }

    baseWeight(card) {
        let weight = 11 - card.cost;
        weight += card.inkwell ? this.inkwellWeight : 0;
        weight += card.lore > 0 ? card.lore / 10 : 0;
        weight += card.sanitizedText ? this.hasAbilityWeight : 0;
        return weight;
    }

    calculateWeight(card, deck) {
        let weight = this.baseWeight(card);
        weight = this.modifyWeightForShiftable(card, weight, deck);
        weight = this.modifyWeightForShift(card, weight, deck);
        weight = this.modifyWeightByEffect(card, weight);
        weight = this.modifyWeightByKeywords(card, weight);
        weight = this.modifyWeightByTypePresence(card, weight, deck);
        weight = this.modifyWeightForSinger(card, weight, deck);
        weight = this.modifyWeightForSong(card, weight, deck);

        weight = this.modifyWeightByTitlePresence(card, weight, deck);
        weight = this.modifyWeightByRequirements(card, weight, deck);

        return weight;
    }

    modifyWeightForSong(card, weight, deck) {
        if (!card.types.includes('Song')) return weight;
        weight += 0.05;

        if (card.text.includes("Sing Together")) {
            weight += 0.05;
        }

        const charactersInDeck = deck.filter(deckCard => deckCard.types.includes('Character')).sort((a, b) => a.singCost - b.singCost);
        charactersInDeck.forEach(character => {
            if (character.singCost < card.cost) {
                weight += 0.1;
            }

            if (character.singCost === card.cost) {
                weight += 0.5;
            }
        });

        return weight;
    }

    modifyWeightForSinger(card, weight, deck) {
        if (!card.hasSinger) return weight;
        const songsInDeck = deck.filter(deckCard => deckCard.types.includes('Song')).sort((a, b) => a.cost - b.cost);
        songsInDeck.forEach(song => {
            if (song.cost < card.singCost) {
                weight += 1.2;
            }
            if (song.cost === card.singCost) {
                weight += 1.5;
            }
            if (song.text.includes("Sing Together")) {
                weight += 1.5;
            }
        });
        return weight;
    }

    modifyWeightForShiftable(card, weight, deck) {
        if (!card.types.includes('Character')) return weight; // Only characters can shift

        const shiftTargets = deck.filter(deckCard => deckCard.hasShift && deckCard.id !== card.id)
        const uniqueShiftTargets = []
        shiftTargets.forEach(shiftTarget => {
            if (!uniqueShiftTargets.includes(shiftTarget)) {
                uniqueShiftTargets.push(shiftTarget)
            }
        })

        if (uniqueShiftTargets.length === 0) return weight;

        for (const shiftTarget of uniqueShiftTargets) {
            if (shiftTarget.canShiftFrom(card)) {
                weight *= card.cost < shiftTarget.cost ? 100 : 1.1;

                break
            }
        }

        return weight;
    }

    modifyWeightForShift(card, weight, deck) {
        if (!card.hasShift) return weight;
        const deckCharacters = deck.filter(deckCard => deckCard.types.includes('Character')) // Only characters can shift

        for (const deckCard of deckCharacters) {
            if (card.canShiftFrom(deckCard) && card.id !== deckCard.id) {
                weight *= deckCard.cost < card.cost ? 100 : 1.1;

                break
            }
        }

        return weight;
    }

    modifyWeightByTitlePresence(card, weight, deck) {
        const uniqueTitles = new Set(deck.map(deckCard => deckCard.title));
        const countCardTitle = deck.filter(deckCard => deckCard.title === card.title).length;
        if (countCardTitle === card.maxAmount) return 0;
        if (countCardTitle === 0) return weight;

        let modifier = Math.max(10 + (4 - countCardTitle), 1);
        for (let i = (10 - card.cost); i < 10; i++) {
            modifier *= 0.9;
        }

        return uniqueTitles.has(card.title) ? weight * modifier : weight;
    }

    modifyWeightByTypePresence(card, weight, deck) {
        const type = card.types[0];
        const targetPercentages = { Character: 0.5, Action: 0.3, Item: 0.1, Location: 0.1 };
        const targetPercentage = targetPercentages[type] || 0;
        const amountOfType = deck.filter(deckCard => deckCard.types.includes(type)).length;

        return amountOfType < deck.length * targetPercentage ? weight + 0.5 : weight;
    }

    modifyWeightByRequirements(card, weight, deck) {
        return card.deckMeetsRequirements(deck) ? weight : weight * this.requiredCardsPunishment;
    }

    modifyWeightByEffect(card, weight) {
        const effects = [
            { text: "this character can't {e} to sing songs.", modifier: -0.5 },
            { text: "draw a card", modifier: 0.1 },
            { text: "banish", modifier: 0.1 },
            { text: "banish all", modifier: 0.2 },
            { text: "return", modifier: 0.1 },
            { text: "into your inkwell", modifier: 0.2 }
        ];
        for (const effect of effects) {
            if (card.sanitizedText.includes(effect.text)) weight += effect.modifier;
        }

        const drawMatch = card.sanitizedText.match(/draws? (\d+) cards/);
        if (drawMatch) weight += (parseInt(drawMatch[1]) / 10)

        const loreMatch = card.sanitizedText.match(/gain (\d+) lore/);
        if (loreMatch) weight += (parseInt(loreMatch[1]) / 10)

        return weight;
    }

    modifyWeightByKeywords(card, weight) {
        const keywords = [
            { key: 'hasBodyguard', modifier: 0.2 },
            { key: 'hasEvasive', modifier: 0.2 },
            { key: 'hasRush', modifier: 0.2 },
            { key: 'hasWard', modifier: 0.1 },
            { key: 'hasSinger', modifier: 0.1 },
            { key: 'hasReckless', modifier: 0.05 },
            { key: 'hasChallenger', modifier: card.challengerAmount / 10 },
            { key: 'hasResist', modifier: card.resistAmount / 10 }
        ];
        for (const keyword of keywords) {
            if (card[keyword.key]) weight += keyword.modifier;
        }
        return weight;
    }
}