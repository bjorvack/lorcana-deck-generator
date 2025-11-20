const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

(async () => {
    console.log('Launching browser...');
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    try {
        console.log('Fetching last 10 tournaments...');
        await page.goto('https://inkdecks.com/lorcana-tournaments?sort=relevance&direction=desc', { waitUntil: 'networkidle2' });
        await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000)); // 3-5s random delay

        const tournamentLinks = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a'));
            return links
                .filter(a => a.href.includes('/lorcana-tournaments/') &&
                    a.href.includes('-tournament-decks-') &&
                    /\d+$/.test(a.href))
                .map(a => ({ href: a.href, text: a.innerText.trim() }))
                .filter(item => item.text.length > 5)
                .slice(0, 10);
        });

        console.log(`Found ${tournamentLinks.length} tournaments`);

        // Process each tournament
        for (const tournament of tournamentLinks) {
            console.log(`\nProcessing: ${tournament.text}`);
            console.log(`URL: ${tournament.href}`);

            // Check if tournament file already exists
            const filename = tournament.href
                .split('/').pop()
                .replace('-tournament-decks', '')
                .replace(/\d+$/, '') +
                new Date().toISOString().split('T')[0] + '.json';
            const outputPath = path.join(__dirname, '..', 'training_data', filename);

            if (fs.existsSync(outputPath)) {
                console.log(`⏭️  Skipping - already scraped (${filename})`);
                continue;
            }

            await page.goto(tournament.href, { waitUntil: 'networkidle2' });
            await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000)); // 2-4s random delay

            // Extract tournament metadata
            const tournamentMeta = await page.evaluate(() => {
                // Extract player count - look for "Players" text in table cells
                let players = null;
                const allCells = Array.from(document.querySelectorAll('td'));
                const playersCell = allCells.find(td => td.innerText.trim().toLowerCase() === 'players');
                if (playersCell && playersCell.nextElementSibling) {
                    const playersText = playersCell.nextElementSibling.innerText;
                    players = playersText ? parseInt(playersText) : null;
                }

                // Extract set and legality from breadcrumbs or page content
                let set = null;
                let legality = null;

                // Try to find set info (e.g., "Set 10" or similar)
                const pageText = document.body.innerText;
                const setMatch = pageText.match(/Set\s+(\d+)/i);
                if (setMatch) {
                    set = parseInt(setMatch[1]);
                }

                // Try to determine legality from URL or page content
                if (pageText.includes('Core') || window.location.href.includes('core')) {
                    legality = 'Core';
                } else if (pageText.includes('Infinity') || window.location.href.includes('infinity')) {
                    legality = 'Infinity';
                }

                return { players, set, legality };
            });

            // Extract deck links with placement and ink colors
            const deckData = await page.evaluate(() => {
                const rows = Array.from(document.querySelectorAll('tr[data-href]'));
                return rows
                    .filter(row => row.getAttribute('data-href')?.includes('/lorcana-metagame/deck-'))
                    .slice(0, 16)
                    .map((row, index) => {
                        const href = row.getAttribute('data-href');

                        // Try to find placement from the row
                        const placeCell = row.querySelector('td:first-child');
                        const place = placeCell ? parseInt(placeCell.innerText) || (index + 1) : (index + 1);

                        // Try to extract ink colors from the row
                        const inks = [];
                        const inkElements = row.querySelectorAll('[class*="ink-"], [data-ink], img[alt*="ink"]');
                        inkElements.forEach(el => {
                            // Check class names for ink colors
                            const classList = el.className.split(' ');
                            classList.forEach(cls => {
                                const inkMatch = cls.match(/ink-(amber|amethyst|emerald|ruby|sapphire|steel)/i);
                                if (inkMatch && !inks.includes(inkMatch[1].toLowerCase())) {
                                    inks.push(inkMatch[1].toLowerCase());
                                }
                            });

                            // Check alt text for ink colors
                            const alt = el.getAttribute('alt') || '';
                            const inkColors = ['amber', 'amethyst', 'emerald', 'ruby', 'sapphire', 'steel'];
                            inkColors.forEach(color => {
                                if (alt.toLowerCase().includes(color) && !inks.includes(color)) {
                                    inks.push(color);
                                }
                            });
                        });

                        return { href, place, inks };
                    });
            });

            console.log(`Found ${deckData.length} decks`);

            const decks = [];

            // Process each deck
            for (const deckInfo of deckData) {
                console.log(`Fetching deck: ${deckInfo.href}`);
                await page.goto(deckInfo.href, { waitUntil: 'networkidle2' });
                await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000)); // 3-5s random delay

                // Get the export URL from the page HTML directly
                const html = await page.content();
                const exportUrlMatch = html.match(/\/decks\/export\/([a-f0-9-]+)/);

                let parsedCards = [];
                if (exportUrlMatch) {
                    const exportUrl = exportUrlMatch[0];
                    console.log(`  Export URL: ${exportUrl}`);

                    // Retry logic for export page fetching
                    const maxRetries = 3;
                    let retryCount = 0;
                    let cardList = null;

                    while (retryCount < maxRetries && !cardList) {
                        if (retryCount > 0) {
                            const delay = 3000 * retryCount; // Exponential backoff: 3s, 6s, 9s
                            console.log(`  Retry ${retryCount}/${maxRetries} after ${delay}ms delay...`);
                            await new Promise(r => setTimeout(r, delay));
                        }

                        try {
                            // Navigate to the TXT export URL with longer wait
                            await page.goto(`https://inkdecks.com${exportUrl}/txt`, { waitUntil: 'networkidle2', timeout: 30000 });
                            await new Promise(r => setTimeout(r, 4000 + Math.random() * 2000)); // 4-6s random wait for Cloudflare

                            // Get the plain text card list
                            cardList = await page.evaluate(() => {
                                const textarea = document.querySelector('textarea');
                                if (textarea && textarea.value) {
                                    return textarea.value;
                                }
                                // Check if it's a Cloudflare challenge page
                                if (document.body.innerText.includes('Verifying you are human') ||
                                    document.body.innerText.includes('Just a moment')) {
                                    return null; // Signal to retry
                                }
                                return document.body.innerText;
                            });

                            // If we got content, try to parse it
                            if (cardList && cardList.trim().length > 0) {
                                const lines = cardList.split('\n').filter(line => line.trim());

                                const tempCards = lines.map(line => {
                                    // Match "N Card Name - Card Subtitle" format
                                    const match = line.match(/^(\d+)\s*[x×]?\s+(.+?)\s*-\s*(.+)$/);
                                    if (match) {
                                        return {
                                            amount: parseInt(match[1]),
                                            name: match[2].trim(),
                                            version: match[3].trim()
                                        };
                                    }
                                    // Also try without version
                                    const simpleMatch = line.match(/^(\d+)\s*[x×]?\s+(.+)$/);
                                    if (simpleMatch && simpleMatch[2].length > 2) {
                                        return {
                                            amount: parseInt(simpleMatch[1]),
                                            name: simpleMatch[2].trim(),
                                            version: ''
                                        };
                                    }
                                    return null;
                                }).filter(card => card !== null && card.amount >= 1 && card.amount <= 4);

                                // Only accept the result if we got some cards
                                if (tempCards.length > 0) {
                                    parsedCards = tempCards;
                                    break; // Success!
                                } else {
                                    cardList = null; // Reset to retry
                                }
                            }
                        } catch (error) {
                            console.log(`  Error on attempt ${retryCount + 1}: ${error.message}`);
                        }

                        retryCount++;
                    }

                    if (parsedCards.length === 0 && retryCount >= maxRetries) {
                        console.log(`  ✗ Failed after ${maxRetries} retries`);
                    }
                }

                if (parsedCards.length > 0) {
                    const deckEntry = {
                        place: deckInfo.place,
                        cards: parsedCards
                    };

                    // Only add inks if we found any
                    if (deckInfo.inks.length > 0) {
                        deckEntry.inks = deckInfo.inks;
                    }

                    decks.push(deckEntry);
                    console.log(`  ✓ Extracted ${parsedCards.length} cards`);
                } else {
                    console.log(`  ✗ Failed to extract cards`);
                }

                // Add a random delay between deck fetches to avoid rate limiting
                await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000)); // 2-4s random delay
            }

            // Save tournament data
            if (decks.length > 0) {
                const tournamentData = {
                    name: tournament.text,
                    url: tournament.href,
                    decks: decks
                };

                // Add metadata if available
                if (tournamentMeta.set || tournamentMeta.legality) {
                    tournamentData.meta = {};
                    if (tournamentMeta.set) tournamentData.meta.set = tournamentMeta.set;
                    if (tournamentMeta.legality) tournamentData.meta.legality = tournamentMeta.legality;
                }

                if (tournamentMeta.players) {
                    tournamentData.players = tournamentMeta.players;
                }

                // Create filename from tournament name
                const filename = tournament.href
                    .split('/').pop()
                    .replace('-tournament-decks', '')
                    .replace(/\d+$/, '') +
                    new Date().toISOString().split('T')[0] + '.json';

                const outputPath = path.join(__dirname, '..', 'training_data', filename);
                fs.writeFileSync(outputPath, JSON.stringify(tournamentData, null, 2));
                console.log(`Saved to: ${outputPath}`);

                // Update manifest
                const manifestPath = path.join(__dirname, '..', 'training_data', 'manifest.json');
                let manifest = [];
                if (fs.existsSync(manifestPath)) {
                    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                }
                if (!manifest.includes(filename)) {
                    manifest.push(filename);
                    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
                }
            }
        }

        console.log('\nScraping complete!');

    } catch (e) {
        console.error('Error:', e);
    } finally {
        await browser.close();
    }
})();
