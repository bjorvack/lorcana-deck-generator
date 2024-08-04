export default class WeightCalculator {
    constructor() {
        this.requiredCardsPunishment = 0.1;
    }

    calculateWeight(card, deck) {
        let weight = 100
        weight = this.modifyWeightForInkwell(card, weight);
        weight = this.modifyWeightForAbility(card, weight);
        weight = this.modifyWeightForShiftable(card, weight, deck);
        weight = this.modifyWeightForShift(card, weight, deck);
        weight = this.modifyWeightByEffect(card, weight);
        weight = this.modifyWeightByKeywords(card, weight);
        weight = this.modifyWeightForSinger(card, weight, deck);
        weight = this.modifyWeightForSong(card, weight, deck);

        weight = this.modifyWeightByTitlePresence(card, weight, deck);
        weight = this.modifyWeightByRequirements(card, weight, deck);

        return weight;
    }

    modifyWeightForInkwell(card, weight) {
        if (!card.inkwell) {
            weight *= 0.85;
        }

        return weight;
    }

    modifyWeightForAbility(card, weight) {
        if (card.sanitizedText !== undefined && card.sanitizedText !== '' && card.sanitizedText !== null) {
            weight *= 1.1;
        }

        return weight;
    }

    modifyWeightForSong(card, weight, deck) {
        if (!card.types.includes('Song')) return weight;
        weight += 5;

        if (card.text.includes("Sing Together")) {
            weight += 5;
        }

        const charactersInDeck = deck.filter(deckCard => deckCard.types.includes('Character')).sort((a, b) => a.singCost - b.singCost);
        charactersInDeck.forEach(character => {
            if (character.singCost < card.cost) {
                weight += 10;
            }

            if (character.singCost === card.cost) {
                weight += 10;
            }
        });

        return weight;
    }

    modifyWeightForSinger(card, weight, deck) {
        if (!card.hasSinger) return weight;
        const songsInDeck = deck.filter(deckCard => deckCard.types.includes('Song')).sort((a, b) => a.cost - b.cost);
        songsInDeck.forEach(song => {
            if (song.cost < card.singCost) {
                weight += 10;
            }
            if (song.cost === card.singCost) {
                weight += 20;
            }
            if (song.text.includes("Sing Together")) {
                weight += 20;
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
                weight *= card.cost < shiftTarget.cost ? 100 : 1.5;

                break
            }
        }

        return weight;
    }

    modifyWeightForShift(card, weight, deck) {
        if (!card.hasShift) return weight;

        if (deck.filter(deckCard => deckCard.hasShift).length === 0) return weight * 100;

        const deckCharacters = deck.filter(deckCard => deckCard.types.includes('Character')) // Only characters can shift

        for (const deckCard of deckCharacters) {
            if (card.canShiftFrom(deckCard) && card.id !== deckCard.id) {
                weight *= deckCard.cost < card.cost ? 100 : 1.5;

                break
            }
        }

        return weight;
    }

    modifyWeightByTitlePresence(card, weight, deck) {
        // If the card is maxAmount times in the deck, reduce the weight to 0
        if (deck.filter(deckCard => deckCard.id === card.id).length >= card.maxAmount) {
            return 0;
        }

        // If the card is in the deck, increase the weight
        if (deck.filter(deckCard => deckCard.id === card.id).length > 0) {
            return weight * 250;
        }

        // If the cards is only in the deck once, increase the weight
        if (deck.filter(deckCard => deckCard.id === card.id).length === 1) {
            return weight * 1000;
        }

        return weight;
    }

    modifyWeightByRequirements(card, weight, deck) {
        if (card.hasRequirementsForDeck(deck)) {
            weight *= 1.4;
        }

        return card.deckMeetsRequirements(deck) ? weight : weight * this.requiredCardsPunishment;
    }

    modifyWeightByEffect(card, weight) {
        const effects = [
            { text: "this character can't {e} to sing songs.", modifier: -50 },
            { text: "draw a card", modifier: 25 },
            { text: "draw 3 cards", modifier: 50 },
            { text: "draws 7 cards", modifier: 50 },
            { text: "banish", modifier: 20 },
            { text: "banish all", modifier: 30 },
            { text: "return", modifier: 15 },
            { text: "into your inkwell", modifier: 20 }
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
            { key: 'hasBodyguard', modifier: 20 },
            { key: 'hasEvasive', modifier: 20 },
            { key: 'hasRush', modifier: 20 },
            { key: 'hasWard', modifier: 10 },
            { key: 'hasSinger', modifier: 10 },
            { key: 'hasReckless', modifier: 5 },
            { key: 'hasChallenger', modifier: card.challengerAmount * 10 },
            { key: 'hasResist', modifier: card.resistAmount * 10 }
        ];
        for (const keyword of keywords) {
            if (card[keyword.key]) weight += keyword.modifier;
        }
        return weight;
    }
}