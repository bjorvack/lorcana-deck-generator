const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TRAINING_DATA_DIR = path.join(__dirname, '..', '..', 'training_data');
const DECKS_DIR = path.join(TRAINING_DATA_DIR, 'decks');
const TOURNAMENTS_DIR = path.join(TRAINING_DATA_DIR, 'tournaments');

// Ensure directories exist
if (!fs.existsSync(DECKS_DIR)) fs.mkdirSync(DECKS_DIR, { recursive: true });
if (!fs.existsSync(TOURNAMENTS_DIR)) fs.mkdirSync(TOURNAMENTS_DIR, { recursive: true });

// Helper to get deck hash
function getDeckHash(cards) {
    // Sort cards by name and version to ensure consistent hashing
    const sorted = [...cards].sort((a, b) => {
        const nameA = a.name.toLowerCase();
        const nameB = b.name.toLowerCase();
        if (nameA < nameB) return -1;
        if (nameA > nameB) return 1;
        // If names are same, check version
        const verA = (a.version || '').toLowerCase();
        const verB = (b.version || '').toLowerCase();
        return verA.localeCompare(verB);
    });

    const signature = sorted.map(c => `${c.amount}x${c.name}|${c.version || ''}`).join('||');
    return crypto.createHash('sha256').update(signature).digest('hex');
}

// Helper to normalize ink combination for directory name
function getInkPath(inks) {
    if (!inks || inks.length === 0) return 'unknown';
    return inks.slice().sort().join('-');
}

async function migrate() {
    console.log('Starting migration...');
    const files = fs.readdirSync(TRAINING_DATA_DIR);
    const tournamentFiles = files.filter(f => f.endsWith('.json') && f.includes('_') && !f.startsWith('manifest') && !f.startsWith('training-state'));

    console.log(`Found ${tournamentFiles.length} tournament files to process.`);

    const tournamentsByYear = {};

    for (const file of tournamentFiles) {
        console.log(`Processing ${file}...`);
        const filePath = path.join(TRAINING_DATA_DIR, file);

        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

            // Extract year from filename (YYYY-MM-DD_...)
            const dateMatch = file.match(/^(\d{4})-\d{2}-\d{2}/);
            const year = dateMatch ? dateMatch[1] : 'unknown';

            if (!tournamentsByYear[year]) {
                tournamentsByYear[year] = [];
            }

            const processedDecks = [];

            if (data.decks) {
                for (const deck of data.decks) {
                    const hash = getDeckHash(deck.cards);
                    const inks = deck.inks || [];
                    const inkPath = getInkPath(inks);

                    // Deck file path
                    const deckDir = path.join(DECKS_DIR, inkPath);
                    if (!fs.existsSync(deckDir)) fs.mkdirSync(deckDir, { recursive: true });

                    const deckFile = path.join(deckDir, `${hash}.json`);

                    // Save deck if it doesn't exist
                    if (!fs.existsSync(deckFile)) {
                        const deckContent = {
                            hash,
                            inks,
                            cards: deck.cards
                        };
                        fs.writeFileSync(deckFile, JSON.stringify(deckContent, null, 2));
                    }

                    // Add reference to tournament
                    processedDecks.push({
                        hash,
                        place: deck.place,
                        inks: deck.inks,
                        player: deck.player // preserve if exists
                    });
                }
            }

            // Create tournament entry
            const tournamentEntry = {
                name: data.name,
                url: data.url,
                date: dateMatch ? dateMatch[0] : null,
                originalFile: file,
                meta: data.meta,
                players: data.players,
                decks: processedDecks
            };

            tournamentsByYear[year].push(tournamentEntry);

        } catch (e) {
            console.error(`Error processing ${file}: ${e.message}`);
        }
    }

    // Save tournament files
    for (const year in tournamentsByYear) {
        const yearFile = path.join(TOURNAMENTS_DIR, `${year}.json`);
        // If file exists, merge? For now, we overwrite as this is a full migration
        // But if running multiple times, we might want to be careful. 
        // We'll just write the new list.
        fs.writeFileSync(yearFile, JSON.stringify(tournamentsByYear[year], null, 2));
        console.log(`Saved ${tournamentsByYear[year].length} tournaments to ${year}.json`);
    }

    console.log('Migration complete!');
}

migrate().catch(console.error);
