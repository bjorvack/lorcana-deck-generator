const TrainingManager = require('./src/TrainingManager');

(async () => {
    try {
        const manager = new TrainingManager();

        // Parse command line arguments
        const args = process.argv.slice(2);
        let epochs = 10;
        let fullRetrain = false;

        for (const arg of args) {
            if (arg === '--full') {
                fullRetrain = true;
            } else if (!isNaN(parseInt(arg))) {
                epochs = parseInt(arg);
            }
        }

        console.log('='.repeat(50));
        console.log('Lorcana Deck Generator - Training');
        console.log('='.repeat(50));
        console.log(`Epochs: ${epochs}`);
        console.log(`Mode: ${fullRetrain ? 'Full Retrain' : 'Incremental Training'}`);
        console.log('='.repeat(50));
        console.log('');

        await manager.startTraining(epochs, fullRetrain);

    } catch (error) {
        console.error('Training failed:', error);
        process.exit(1);
    }
})();
