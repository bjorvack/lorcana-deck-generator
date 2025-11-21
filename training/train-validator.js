const TrainingManager = require('./src/TrainingManager');
const ValidationModel = require('./src/ValidationModel');
const path = require('path');

(async () => {
    try {
        const manager = new TrainingManager();
        const validationModel = new ValidationModel();

        // Parse command line arguments
        const args = process.argv.slice(2);
        let epochs = 30;

        for (const arg of args) {
            if (!isNaN(parseInt(arg))) {
                epochs = parseInt(arg);
            }
        }

        console.log('='.repeat(50));
        console.log('Lorcana Deck Validator - Training');
        console.log('='.repeat(50));
        console.log(`Epochs: ${epochs}`);
        console.log('='.repeat(50));
        console.log('');

        // 1. Load cards
        console.log('Fetching cards...');
        manager.cards = await manager.cardApi.getCards();
        console.log(`Fetched ${manager.cards.length} cards.`);

        // Build Card Maps
        manager.cards.forEach((card) => {
            const key = manager.getCardKey(card.name, card.version);
            if (!manager.cardMap.has(key)) {
                const id = manager.cardMap.size;
                manager.cardMap.set(key, id);
                manager.indexMap.set(id, card);
            }
        });
        console.log(`Unique cards indexed: ${manager.cardMap.size}`);

        // 2. Load tournament data
        console.log('Loading tournament data...');
        const fs = require('fs');
        const manifestPath = path.join(manager.trainingDataPath, 'manifest.json');
        const allFiles = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

        for (const file of allFiles) {
            const filePath = path.join(manager.trainingDataPath, file);
            if (fs.existsSync(filePath)) {
                const rawData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                manager.trainingData.push(rawData);
            }
        }
        console.log(`Loaded ${manager.trainingData.length} tournament files`);

        // 3. Prepare validation dataset
        const dataset = manager.prepareValidationDataset();

        if (dataset.features.length === 0) {
            console.error('No training data available!');
            process.exit(1);
        }

        // 4. Initialize validation model
        const featureDim = dataset.features[0].length;
        console.log(`Feature dimension: ${featureDim}`);
        await validationModel.initialize(featureDim);

        // 5. Train validation model
        console.log('Training validation model...');
        await validationModel.train(
            dataset.features,
            dataset.labels,
            epochs,
            (epoch, logs) => {
                console.log(
                    `Epoch ${epoch + 1}/${epochs}: ` +
                    `loss = ${logs.loss.toFixed(4)}, ` +
                    `acc = ${logs.acc.toFixed(4)}, ` +
                    `val_loss = ${logs.val_loss.toFixed(4)}, ` +
                    `val_acc = ${logs.val_acc.toFixed(4)}`
                );
            }
        );

        console.log('Training complete!');

        // 6. Save model
        const modelPath = path.join(manager.trainingDataPath, 'deck-validator-model');
        await validationModel.saveModel(modelPath);
        console.log(`Model saved to ${modelPath}`);

        // 7. Test on a few random real and fake decks
        console.log('\n' + '='.repeat(50));
        console.log('Testing model on sample decks...');
        console.log('='.repeat(50));

        // Test on a real deck
        const realDeck = manager.trainingData[0].decks[0];
        const realDeckIndices = [];
        for (const cardEntry of realDeck.cards) {
            const key = manager.getCardKey(cardEntry.name, cardEntry.version);
            if (manager.cardMap.has(key)) {
                const index = manager.cardMap.get(key);
                for (let i = 0; i < cardEntry.amount; i++) {
                    realDeckIndices.push(index);
                }
            }
        }
        const realFeatures = manager.extractDeckFeatures(realDeckIndices.slice(0, 60));
        const realScore = await validationModel.evaluate(realFeatures);
        console.log(`Real tournament deck score: ${(realScore * 100).toFixed(1)}% (${validationModel.getGrade(realScore)})`);
        console.log(`Message: ${validationModel.getMessage(realScore)}`);

        // Test on fake decks
        for (const strategy of ['pure_random', 'ink_constrained', 'rule_broken']) {
            const fakeDeck = manager.generateFakeDeck(strategy);
            const fakeFeatures = manager.extractDeckFeatures(fakeDeck);
            const fakeScore = await validationModel.evaluate(fakeFeatures);
            console.log(`Fake deck (${strategy}) score: ${(fakeScore * 100).toFixed(1)}% (${validationModel.getGrade(fakeScore)})`);
        }

        console.log('\n' + '='.repeat(50));
        console.log('Validation model training complete!');
        console.log('='.repeat(50));

    } catch (error) {
        console.error('Training failed:', error);
        console.error(error.stack);
        process.exit(1);
    }
})();
