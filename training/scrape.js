const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

puppeteer.use(StealthPlugin());

(async () => {
  const args = process.argv.slice(2)
  const isDev = args.includes('--dev')

  console.log('Launching browser...')
  const browser = await puppeteer.launch({
    headless: true
  })
  const page = await browser.newPage()

  // Set a large viewport and User Agent to ensure desktop layout
  await page.setViewport({
    width: 1920,
    height: 1080
  })
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  )

  // Helper: Get deck hash
  function getDeckHash(cards) {
    const sorted = [...cards].sort((a, b) => {
      const nameA = a.name.toLowerCase()
      const nameB = b.name.toLowerCase()
      if (nameA < nameB) return -1
      if (nameA > nameB) return 1
      const verA = (a.version || '').toLowerCase()
      const verB = (b.version || '').toLowerCase()
      return verA.localeCompare(verB)
    })

    const signature = sorted.map(c => `${c.amount}x${c.name}|${c.version || ''}`).join('||')
    return crypto.createHash('sha256').update(signature).digest('hex')
  }

  function getInkPath(inks) {
    if (!inks || inks.length === 0) return null
    return inks.slice().sort().join('-')
  }

  // Helper: Get tournament hash (name + date)
  function getTournamentHash(name, date) {
    const signature = `${name}|${date}`
    return crypto.createHash('sha256').update(signature).digest('hex')
  }

  // Helper: Get set of all existing tournament hashes
  function getExistingTournamentHashes() {
    const hashes = new Set()
    const tournamentsDir = path.join(__dirname, '..', 'training_data', 'tournaments')

    if (fs.existsSync(tournamentsDir)) {
      const files = fs.readdirSync(tournamentsDir).filter(f => f.endsWith('.json'))
      for (const file of files) {
        try {
          const filePath = path.join(tournamentsDir, file)
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
          for (const t of data) {
            if (t.hash) {
              hashes.add(t.hash)
            } else if (t.name && t.date) {
              hashes.add(getTournamentHash(t.name, t.date))
            }
          }
        } catch (e) {
          console.warn(`Warning: Could not read/parse tournament file ${file}: ${e.message}`)
        }
      }
    }
    return hashes
  }

  try {
    console.log('Fetching and processing all tournaments...')

    // Pre-load all existing tournament hashes
    const existingTournamentHashes = getExistingTournamentHashes()
    console.log(`Loaded ${existingTournamentHashes.size} existing tournaments to skip.`)

    let currentPage = 1
    let hasMorePages = true
    let totalProcessed = 0

    // Process tournaments page by page
    // Check if we should limit to first page only (for CI/scheduled runs)
    const firstPageOnly =
      process.env.FIRST_PAGE_ONLY === 'true' || args.includes('--first-page')

    while (hasMorePages) {
      console.log(`\n========== Fetching page ${currentPage} ==========`)
      const pageUrl =
        currentPage === 1 ?
          'https://inkdecks.com/lorcana-tournaments/core?sort=date&direction=asc' :
          `https://inkdecks.com/lorcana-tournaments/core?sort=date&direction=asc&page=${currentPage}`

      await page.goto(pageUrl, {
        waitUntil: 'networkidle2'
      })
      await new Promise((resolve) =>
        setTimeout(resolve, 3000 + Math.random() * 2000)
      ) // 3-5s random delay

      const tournamentLinks = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a'))
        return links
          .filter(
            (a) =>
              a.href.includes('/lorcana-tournaments/') &&
              a.href.includes('-tournament-decks-') &&
              /\d+$/.test(a.href)
          )
          .map((a) => {
            // Find the parent row to extract the date
            let dateStr = null
            const row = a.closest('tr')
            let debugCells = []

            if (row) {
              // Look for date in table cells - typically in format like "Nov 20, 2025" or similar
              const cells = Array.from(row.querySelectorAll('td'))
              debugCells = cells.map((c) => c.innerText.trim())

              for (const cell of cells) {
                const text = cell.innerText.trim()
                // Match common date patterns:
                // 1. YYYY-MM-DD (2025-11-20)
                // 2. MMM D, YYYY (Nov 20, 2025)
                // 3. MM/DD/YYYY (11/20/2025)
                // 4. MMM-DD (Nov-16) - Fallback for mobile view, might need year inference
                if (
                  /\b\d{4}-\d{2}-\d{2}\b/.test(text) ||
                  /\b\w{3}\s+\d{1,2},\s+\d{4}\b/.test(text) ||
                  /\b\d{1,2}\/\d{1,2}\/\d{4}\b/.test(text)
                ) {
                  dateStr = text
                  break
                }
                // Fallback for "Nov-16" style
                if (/\b[A-Z][a-z]{2}-\d{1,2}\b/.test(text)) {
                  const match = text.match(/\b([A-Z][a-z]{2})-(\d{1,2})\b/)
                  if (match) {
                    // Assume current year or 2025 if not found.
                    // Ideally we want the full date, but this is a fallback.
                    // We'll try to construct a date string.
                    dateStr = `${match[1]} ${match[2]}, 2025` // Hardcoded 2025 as safe bet for now given the context
                  }
                }
              }
            }

            return {
              href: a.href,
              text: a.innerText.trim(),
              dateStr,
              debugCells // Return cells for debugging if date is missing
            }
          })
          .filter((item) => item.text.length > 5)
      })

      if (tournamentLinks.length === 0) {
        console.log(
          `No tournaments found on page ${currentPage}, stopping pagination.`
        )
        hasMorePages = false
        break
      }

      console.log(
        `Found ${tournamentLinks.length} tournaments on page ${currentPage}`
      )

      // PROCESS TOURNAMENTS
      for (const tournament of tournamentLinks) {
        console.log(`\nProcessing: ${tournament.text}`)
        console.log(`URL: ${tournament.href}`)

        // Parse date
        let tournamentDate = 'unknown-date'
        let year = 'unknown'
        if (tournament.dateStr) {
          try {
            const parsed = new Date(tournament.dateStr)
            if (!isNaN(parsed.getTime())) {
              tournamentDate = parsed.toISOString().split('T')[0]
              year = parsed.getFullYear().toString()
            }
          } catch (e) {
            console.log(`  Warning: Could not parse date: ${tournament.dateStr}`)
          }
        }

        // Check if tournament already exists in the year file
        const yearFilePath = path.join(__dirname, '..', 'training_data', 'tournaments', `${year}.json`)
        let yearData = []
        if (fs.existsSync(yearFilePath)) {
          try {
            yearData = JSON.parse(fs.readFileSync(yearFilePath, 'utf8'))
          } catch (e) {
            console.error('Error reading year file, starting fresh array')
          }
        }

        // Check if tournament already exists (by name + date hash)
        const currentHash = getTournamentHash(tournament.text, tournamentDate)

        if (existingTournamentHashes.has(currentHash)) {
          console.log(`⏭️  Skipping - already scraped (${tournament.text} | ${tournamentDate})`)
          continue
        }

        await page.goto(tournament.href, {
          waitUntil: 'networkidle2'
        })
        await new Promise((resolve) =>
          setTimeout(resolve, 2000 + Math.random() * 2000)
        ) // 2-4s random delay

        // Extract tournament metadata
        const tournamentMeta = await page.evaluate(() => {
          // Extract player count
          let players = null
          const allCells = Array.from(document.querySelectorAll('td'))
          const playersCell = allCells.find(
            (td) => td.innerText.trim().toLowerCase() === 'players'
          )
          if (playersCell && playersCell.nextElementSibling) {
            const playersText = playersCell.nextElementSibling.innerText
            players = playersText ? parseInt(playersText) : null
          }

          // Extract set and legality
          let set = null
          let legality = null
          const pageText = document.body.innerText
          const setMatch = pageText.match(/Set\s+(\d+)/i)
          if (setMatch) {
            set = parseInt(setMatch[1])
          }
          if (pageText.includes('Core') || window.location.href.includes('core')) {
            legality = 'Core'
          } else if (pageText.includes('Infinity') || window.location.href.includes('infinity')) {
            legality = 'Infinity'
          }

          return {
            players,
            set,
            legality
          }
        })

        // Extract deck links
        const deckData = await page.evaluate(() => {
          const rows = Array.from(document.querySelectorAll('tr[id^="desktop-deck-"]'))
          return rows
            .filter((row) =>
              row.getAttribute('data-href')?.includes('/lorcana-metagame/deck-')
            )
            .map((row, index) => {
              const href = row.getAttribute('data-href')

              const placeCell = row.querySelector('td')
              let place = index + 1 // Default fallback

              if (placeCell) {
                const text = placeCell.innerText.trim()

                if (text.toLowerCase().includes('winner') || text.includes('1st')) {
                  place = 1
                }
                else if (text.toLowerCase().includes('finalist') || text.toLowerCase().includes('runner') || text.includes('2nd')) {
                  place = 2
                }
                else {
                  const match = text.match(/(\d+)/)
                  if (match) place = parseInt(match[1])
                }
              }

              const inks = []
              return {
                href,
                place,
                inks
              }
            })
        })

        console.log(`Found ${deckData.length} decks`)

        const processedDecks = []

        // Process each deck
        for (const deckInfo of deckData) {
          console.log(`Fetching deck (Place: ${deckInfo.place}): ${deckInfo.href}`)

          await page.goto(deckInfo.href, {
            waitUntil: 'networkidle2'
          })
          await new Promise((resolve) =>
            setTimeout(resolve, 3000 + Math.random() * 2000)
          ) // 3-5s random delay

          // Get the export URL from the page HTML directly
          const html = await page.content()
          const exportUrlMatch = html.match(/\/decks\/export\/([a-f0-9-]+)/)

          let parsedCards = []
          let failureReason = 'Unknown Error'

          if (exportUrlMatch) {
            const exportUrl = exportUrlMatch[0]

            // --- INK SCRAPING (Primary) ---
            // Fetch inks from the deck page details
            if (!deckInfo.inks || deckInfo.inks.length === 0) {
              console.log('  Testing deck page for ink colors...')
              const pageInks = await page.evaluate(() => {
                const foundInks = []
                const images = Array.from(document.querySelectorAll('img'))
                const inkColors = ['amber', 'amethyst', 'emerald', 'ruby', 'sapphire', 'steel']

                images.forEach(img => {
                  const alt = (img.getAttribute('alt') || '').toLowerCase()
                  const src = (img.getAttribute('src') || '').toLowerCase()
                  const className = (img.className || '').toLowerCase()

                  inkColors.forEach(color => {
                    if (
                      (alt.includes(color) || src.includes(color) || className.includes(color)) &&
                      !foundInks.includes(color)
                    ) {
                      foundInks.push(color)
                    }
                  })
                })

                if (foundInks.length === 0) {
                  const bodyText = document.body.innerText.toLowerCase()
                  const headerText = bodyText.substring(0, 1000)
                  inkColors.forEach(color => {
                    if (headerText.includes(color) && !foundInks.includes(color)) {
                      foundInks.push(color)
                    }
                  })
                }
                return foundInks
              })

              if (pageInks.length > 0) {
                deckInfo.inks = pageInks
                console.log(`  ✓ Found inks on deck page: ${pageInks.join(', ')}`)
              } else {
                console.log('  ✗ Could not find inks on deck page.')
              }
            }
            // ----------------------------------

            const maxRetries = 3
            let retryCount = 0
            let cardList = null

            while (retryCount < maxRetries && !cardList) {
              if (retryCount > 0) {
                await new Promise((resolve) => setTimeout(resolve, 3000 * retryCount))
              }
              try {
                await page.goto(`https://inkdecks.com${exportUrl}/txt`, {
                  waitUntil: 'networkidle2',
                  timeout: 30000
                })
                await new Promise((resolve) =>
                  setTimeout(resolve, 4000 + Math.random() * 2000)
                )

                const result = await page.evaluate(() => {
                  const textarea = document.querySelector('textarea')
                  if (textarea && textarea.value) return { type: 'success', content: textarea.value }
                  const bodyText = document.body.innerText
                  if (
                    bodyText.includes('Verifying you are human') ||
                    bodyText.includes('Just a moment')
                  ) {
                    return { type: 'captcha', content: null }
                  }
                  return { type: 'empty', content: bodyText }
                })

                if (result.type === 'success' && result.content.trim().length > 0) {
                  cardList = result.content
                  const lines = cardList.split('\n').filter((line) => line.trim())
                  const tempCards = lines.map((line) => {
                    const match = line.match(/^(\d+)\s*[x×]?\s+(.+?)\s*-\s*(.+)$/)
                    if (match) return {
                      amount: parseInt(match[1]),
                      name: match[2].trim(),
                      version: match[3].trim()
                    }
                    const simpleMatch = line.match(/^(\d+)\s*[x×]?\s+(.+)$/)
                    if (simpleMatch && simpleMatch[2].length > 2) {
                      return {
                        amount: parseInt(simpleMatch[1]),
                        name: simpleMatch[2].trim(),
                        version: ''
                      }
                    }
                    return null
                  }).filter(c => c !== null && c.amount >= 1 && c.amount <= 4)

                  if (tempCards.length > 0) {
                    parsedCards = tempCards
                    break
                  } else {
                    failureReason = 'Parsed 0 valid cards from text content'
                    cardList = null
                  }
                } else if (result.type === 'captcha') {
                  failureReason = 'Cloudflare/Captcha detected'
                } else {
                  failureReason = 'No textarea found or empty content'
                }
              } catch (e) {
                console.log(`  Error retry ${retryCount}: ${e.message}`)
                failureReason = `Exception: ${e.message}`
              }
              retryCount++
            }
          } else {
            failureReason = 'No export URL found in page HTML'
          }

          if (parsedCards.length > 0) {
            const inkPath = getInkPath(deckInfo.inks)

            // Strict validation: Decks must have identified inks
            if (!inkPath) {
              console.error('  🛑 FATAL: Deck found with unknown/missing inks!')
              console.error(`  URL: ${deckInfo.href}`)
              console.error('  Please inspect the page to see where ink information is located.')
              process.exit(1) // Stop the script as requested
            } else {
              const hash = getDeckHash(parsedCards)

              // Save dedicated deck file if not exists
              const deckDir = path.join(__dirname, '..', 'training_data', 'decks', inkPath)
              if (!fs.existsSync(deckDir)) fs.mkdirSync(deckDir, {
                recursive: true
              })

              const deckFile = path.join(deckDir, `${hash}.json`)
              if (!fs.existsSync(deckFile)) {
                const deckContent = {
                  hash,
                  inks: deckInfo.inks,
                  cards: parsedCards
                }
                fs.writeFileSync(deckFile, JSON.stringify(deckContent, null, 2))
                console.log(`  ✓ Saved new deck: ${hash.substring(0, 8)}...`)
              } else {
                console.log(`  ✓ Deck already exists: ${hash.substring(0, 8)}...`)
              }

              // Add to tournament list
              processedDecks.push({
                hash,
                place: deckInfo.place,
                inks: deckInfo.inks
              })
            }
          } else {
            console.log(`  ✗ Failed to extract cards: ${failureReason}`)
          }

          await new Promise((resolve) =>
            setTimeout(resolve, 2000 + Math.random() * 2000)
          )
        }

        // Save tournament entry ONLY if we have decks
        if (processedDecks.length > 0) {
          const tournamentEntry = {
            hash: currentHash,
            name: tournament.text,
            url: tournament.href,
            date: tournamentDate,
            meta: {},
            players: tournamentMeta.players, // can be null
            decks: processedDecks
          }
          if (tournamentMeta.set) tournamentEntry.meta.set = tournamentMeta.set
          if (tournamentMeta.legality) tournamentEntry.meta.legality = tournamentMeta.legality

          // Re-read file to prevent race conditions roughly (not perfect but OK for single thread loop)
          if (fs.existsSync(yearFilePath)) {
            yearData = JSON.parse(fs.readFileSync(yearFilePath, 'utf8'))
          }
          yearData.push(tournamentEntry)

          // Create directory if needed
          const tournamentsDir = path.dirname(yearFilePath)
          if (!fs.existsSync(tournamentsDir)) fs.mkdirSync(tournamentsDir, { recursive: true })

          fs.writeFileSync(yearFilePath, JSON.stringify(yearData, null, 2))
          console.log(`Saved tournament to ${year}.json`)
        }

        totalProcessed++
      }

      console.log(
        `\nCompleted page ${currentPage}. Processed ${totalProcessed} tournaments so far.`
      )

      if (firstPageOnly) {
        console.log('First page only mode - stopping pagination.')
        hasMorePages = false
        break
      }

      currentPage++
      await new Promise((resolve) =>
        setTimeout(resolve, 2000 + Math.random() * 2000)
      )
    }

    console.log('\n========== Scraping complete! ==========')
    console.log(`Total tournaments processed: ${totalProcessed}`)
    console.log(`Total pages: ${currentPage - 1}`)

  } catch (e) {
    console.error('Error:', e)
  } finally {
    await browser.close()
  }
})()
