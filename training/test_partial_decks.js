const TrainingManager = require('./src/TrainingManager');

async function testPartialDeckGeneration() {
    console.log('=== Testing Partial Deck Generation ===\n');

    const tm = new TrainingManager();

    // Load cards first
    console.log('Loading cards...');
    tm.cards = await tm.cardApi.getCards();
    console.log(`Loaded ${tm.cards.length} cards\n`);

    // Build card maps
    tm.cards.forEach((card) => {
        const key = tm.getCardKey(card.name, card.version);
        if (!tm.cardMap.has(key)) {
            const id = tm.cardMap.size;
            tm.cardMap.set(key, id);
            tm.indexMap.set(id, card);
        }
    });
    console.log(`Indexed ${tm.cardMap.size} unique cards\n`);

    // Test 1: Generate partial deck from a simulated full deck
    console.log('Test 1: Generating partial deck from simulated deck...');
    const fullDeck = Array(60).fill(0).map((_, i) => i % 20); // Simulate 60 cards with 20 unique
    const partial = tm.generatePartialDeck(fullDeck);
    console.log(`✓ Full deck size: ${fullDeck.length}`);
    console.log(`✓ Partial deck size: ${partial.length}`);
    console.log(`✓ Cards removed: ${60 - partial.length}`);

    if (partial.length >= 40 && partial.length <= 50) {
        console.log('✓ Test 1 PASSED: Partial deck size is correct (40-50 cards)\n');
    } else {
        console.error('✗ Test 1 FAILED: Partial deck size is incorrect\n');
        process.exit(1);
    }

    // Test 2: Complete partial deck back to 60
    console.log('Test 2: Completing partial deck back to 60...');
    const completed = tm.completePartialDeckWithGenerator(partial);
    console.log(`✓ Completed deck size: ${completed.length}`);

    if (completed.length === 60) {
        console.log('✓ Test 2 PASSED: Completed deck is exactly 60 cards\n');
    } else {
        console.error('✗ Test 2 FAILED: Completed deck is not 60 cards\n');
        process.exit(1);
    }

    // Test 3: Verify completed deck has valid cards
    console.log('Test 3: Verifying completed deck has valid cards...');
    const cardsInCompleted = new Set(completed);
    const validCards = Array.from(cardsInCompleted).every(idx => tm.indexMap.has(idx));

    if (validCards) {
        console.log(`✓ Test 3 PASSED: All ${cardsInCompleted.size} unique cards in completed deck are valid\n`);
    } else {
        console.error('✗ Test 3 FAILED: Some cards in completed deck are invalid\n');
        process.exit(1);
    }

    // Test 4: Check card count respects max amounts
    console.log('Test 4: Checking card counts respect max amounts...');
    const cardCounts = new Map();
    for (const idx of completed) {
        cardCounts.set(idx, (cardCounts.get(idx) || 0) + 1);
    }

    let maxAmountViolations = 0;
    for (const [idx, count] of cardCounts.entries()) {
        const card = tm.indexMap.get(idx);
        const maxAmount = card?.maxAmount || 4;
        if (count > maxAmount) {
            console.error(`  ✗ Card ${card?.name} has ${count} copies (max ${maxAmount})`);
            maxAmountViolations++;
        }
    }

    if (maxAmountViolations === 0) {
        console.log('✓ Test 4 PASSED: All card counts respect max amounts\n');
    } else {
        console.error(`✗ Test 4 FAILED: ${maxAmountViolations} max amount violations\n`);
        process.exit(1);
    }

    console.log('=== All Tests Passed! ===');
    console.log('\nPartial deck generation is working correctly.');
    console.log('The validator training will now include medium-quality partial decks.');
}

testPartialDeckGeneration().catch(console.error);
