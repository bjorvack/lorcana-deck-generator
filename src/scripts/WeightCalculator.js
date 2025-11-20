export default class WeightCalculator {

  calculateWeight(card, deck, deckType, triesRemaining) {
    let weight = 1
    weight = this.modifyWeightForInkwell(card, weight);
    weight = this.modifyWeightForAbility(card, weight);
    weight = this.modifyWeightForShiftable(card, weight, deck);
    weight = this.modifyWeightForShift(card, weight, deck);
    weight = this.modifyWeightByEffect(card, weight);
    weight = this.modifyWeightByKeywords(card, weight);
    weight = this.modifyWeightForSinger(card, weight, deck);
    weight = this.modifyWeightForSong(card, weight, deck);
    weight = this.modifyWeightByTitlePresence(card, weight, deck, triesRemaining);
    weight = this.modifyWeightByRequirements(card, weight, deck);

    weight = this.modifyWeightByDeckType(card, weight, deckType);

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
    weight *= 1.2;

    if (card.text.includes("Sing Together")) {
      weight *= 1.05;
    }

    const charactersInDeck = deck.filter(deckCard => deckCard.types.includes('Character')).sort((a, b) => a.singCost - b.singCost);
    charactersInDeck.forEach(character => {
      if (character.singCost < card.cost) {
        weight *= 0.95;
      }

      if (character.singCost === card.cost) {
        weight *= 1.2;
      }
    });

    return weight;
  }

  modifyWeightForSinger(card, weight, deck) {
    if (!card.hasSinger) return weight;
    const songsInDeck = deck.filter(deckCard => deckCard.types.includes('Song')).sort((a, b) => a.cost - b.cost);
    songsInDeck.forEach(song => {
      if (song.cost < card.singCost) {
        weight *= 1.1;
      }
      if (song.cost === card.singCost) {
        weight *= 1.15;
      }
      if (song.text.includes("Sing Together")) {
        weight *= 1.05;
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
        weight *= card.cost < shiftTarget.cost ? 1.6 : 0.95;

        break
      }
    }

    return weight;
  }

  modifyWeightForShift(card, weight, deck) {
    if (!card.hasShift) return weight;

    if (deck.filter(deckCard => deckCard.hasShift).length === 0) return weight * 1.5;

    const deckCharacters = deck.filter(deckCard => deckCard.types.includes('Character')) // Only characters can shift

    for (const deckCard of deckCharacters) {
      if (card.canShiftFrom(deckCard) && card.id !== deckCard.id) {
        weight *= deckCard.cost < card.cost ? 1.6 : 0.95;

        break
      }
    }

    return weight;
  }

  modifyWeightByTitlePresence(card, weight, deck, triesRemaining) {
    // If the card is maxAmount times in the deck, reduce the weight to 0
    if (deck.filter(deckCard => deckCard.id === card.id).length >= card.maxAmount) {
      return 0;
    }

    // If the card is in the deck, increase the weight
    if (deck.filter(deckCard => deckCard.id === card.id).length > 0) {
      return weight * (100 - triesRemaining);
    }

    // If the cards is only in the deck once, increase the weight
    if (deck.filter(deckCard => deckCard.id === card.id).length === 1) {
      return weight * 20;
    }

    return weight;
  }

  modifyWeightByRequirements(card, weight, deck) {
    if (card.hasRequirementsForDeck(deck)) {
      weight *= 1.8;
    }

    return card.deckMeetsRequirements(deck) ? weight : 0.05;
  }

  modifyWeightByEffect(card, weight) {
    const effects = [
      { text: "this character can't {e} to sing songs.", modifier: 0.5 },
      { text: "draw a card", modifier: 1.2 },
      { text: "draw 3 cards", modifier: 1.1 },
      { text: "draws 7 cards", modifier: 1.1 },
      { text: "banish", modifier: 1.2 },
      { text: "banish all", modifier: 1.1 },
      { text: "return", modifier: 1.05 },
      { text: "into your inkwell", modifier: 1.1 }
    ];

    let hasEffect = false

    for (const effect of effects) {
      if (card.sanitizedText.includes(effect.text)) {
        weight *= effect.modifier
        hasEffect = true
      }
    }

    const drawMatch = card.sanitizedText.match(/draws? (\d+) cards/);
    if (drawMatch) {
      weight *= (1 + (parseInt(drawMatch[1]) / 10) / 100)
      hasEffect = true
    }

    const loreMatch = card.sanitizedText.match(/gain (\d+) lore/);
    if (loreMatch) {
      weight *= (1 + (parseInt(loreMatch[1]) / 10) / 100)
      hasEffect = true
    }

    if (card.types.includes('Character') && !hasEffect && !this.hasKeywords(card)) weight *= 0.5

    return weight;
  }

  hasKeywords(card) {
    return card.hasBodyguard || card.hasEvasive || card.hasRush || card.hasWard || card.hasSinger || card.hasReckless || card.hasChallenger || card.hasResist
  }

  modifyWeightByKeywords(card, weight) {
    const keywords = [
      { key: 'hasBodyguard', modifier: 1.1 },
      { key: 'hasEvasive', modifier: 1.2 },
      { key: 'hasRush', modifier: 1.05 },
      { key: 'hasWard', modifier: 1.05 },
      { key: 'hasSinger', modifier: 1.3 },
      { key: 'hasBoost', modifier: 1.1 },
      { key: 'hasReckless', modifier: 0.95 },
      { key: 'hasChallenger', modifier: 1 + (card.challengerAmount / 10) },
      { key: 'hasResist', modifier: 1 + (card.resistAmount / 10) }
    ];
    for (const keyword of keywords) {
      if (card[keyword.key]) weight *= keyword.modifier;
    }
    return weight;
  }

  modifyWeightByDeckType(card, weight, deckType) {
    if (deckType === 'default') {
      return weight;
    }

    if (card.cost <= 3) {
      const effects = [
        { text: "banish", modifier: 1.4 },
        { text: "banish all", modifier: 1.4 },
        { text: "return", modifier: 1.7 },
        { text: "into your inkwell", modifier: 1.05 }
      ];

      for (const effect of effects) {
        if (card.sanitizedText.includes(effect.text)) weight *= effect.modifier;
      }
    }

    if (card.lore > 1) {
      weight *= 1 + (card.lore / 10);
    }

    return weight
  }
}
