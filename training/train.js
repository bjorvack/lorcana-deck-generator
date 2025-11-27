const TrainingManager = require('./src/TrainingManager');

(async () => {
    try {
        const manager = new TrainingManager();

        // Parse command line arguments
        const args = process.argv.slice(2);
        let epochs = 20;
        let fullRetrain = false;
        let continueTraining = false;

        for (const arg of args) {
            if (arg === '--full') {
                fullRetrain = true;
            } else if (arg === '--continue') {
                continueTraining = true;
            } else if (!isNaN(parseInt(arg))) {
                epochs = parseInt(arg);
            }
        }

        console.log('='.repeat(50));
        console.log('Lorcana Deck Generator - Training');
        console.log('='.repeat(50));
        console.log(`Epochs: ${epochs}`);
        console.log(`Mode: ${fullRetrain ? 'Full Retrain' : continueTraining ? 'Continue Training' : 'Incremental Training'}`);
        console.log('='.repeat(50));
        console.log('');

        await manager.startTraining(epochs, fullRetrain, continueTraining);

    } catch (error) {
        console.error('Training failed:', error);
        process.exit(1);
    }
})();
