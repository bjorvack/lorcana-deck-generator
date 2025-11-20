const TrainingManager = require('./src/TrainingManager');

(async () => {
    try {
        const manager = new TrainingManager();

        // Get epochs from command line arg or default to 10
        const epochs = process.argv[2] ? parseInt(process.argv[2]) : 10;

        console.log('Initializing training...');
        await manager.startTraining(epochs);

    } catch (error) {
        console.error('Training failed:', error);
        process.exit(1);
    }
})();
