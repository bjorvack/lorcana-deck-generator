import './styles/main.css'
import ModelManager from './scripts/ModelManager'
import Chart from './scripts/Chart'
import CardSelector from './scripts/CardSelector'
import DeckRenderer from './scripts/DeckRenderer'
import InkSelector from './scripts/InkSelector'
import CardPreview from './scripts/CardPreview'

document.addEventListener('DOMContentLoaded', async () => {
  const manager = new ModelManager()

  // UI Elements
  const generateDeckBtn = document.getElementById('generate-deck-btn')
  const testDeckBtn = document.getElementById('test-deck-btn')
  const clearDeckBtn = document.getElementById('clear-deck-btn')
  const chartCanvas = document.querySelector('[data-role="chart"]')
  const legalOnlyCheckbox = document.getElementById('legal-only')

  const chart = new Chart(chartCanvas)
  let cardSelector
  const deckRenderer = new DeckRenderer(document.querySelector('[data-role="deck"]'), {
    onRemove: (cardId) => {
      const index = currentDeck.findIndex(c => c.id === cardId)
      if (index !== -1) {
        currentDeck.splice(index, 1)
        updateDeckPreview()
        cardSelector.refresh()
      }
    },
    onAdd: () => cardSelector.show(),
    onCardClick: (card) => cardPreview.show(card.image, card.name),
    isEditable: true,
    showAddPlaceholder: true
  })
  const cardPreview = new CardPreview()

  let currentDeck = [] // Store actual Card objects
  let currentInks = []

  // Initialize InkSelector
  // eslint-disable-next-line no-unused-vars
  const inkSelector = new InkSelector(
    document.querySelector('[data-role="ink-selector"]'),
    {
      onChange: (inks) => {
        currentInks = inks
        // Remove cards that don't match new inks
        const validDeck = currentDeck.filter(card => {
          return currentInks.includes(card.ink) || checkDualInks(card, currentInks)
        })

        if (validDeck.length !== currentDeck.length) {
          currentDeck = validDeck
          updateDeckPreview()
        }

        if (cardSelector) cardSelector.refresh()
      }
    }
  )

  // Initial render to show placeholder
  updateDeckPreview()

  // Auto-load model and initialize
  try {
    console.log('Loading AI model...')

    // Load the RL-optimized model (trained with validator feedback)
    try {
      await manager.loadModel('training_data/deck-generator-rl/model.json')
      console.log('✅ Loaded RL-optimized model')
    } catch (e) {
      console.warn('⚠️ RL model not found, falling back to base model...')
      await manager.loadModel('training_data/deck-generator-model/model.json')
      console.log('✅ Loaded base generator model')
    }

    // Initialize card selector after cards are loaded
    cardSelector = new CardSelector(
      manager.cards,
      document.querySelector('[data-role=card-select]'),
      (card) => addCardToDeck(card),
      {
        filter: (card) => {
          // Filter by ink
          if (currentInks.length > 0) {
            const inkMatch = currentInks.includes(card.ink) || checkDualInks(card, currentInks)
            if (!inkMatch) return false
          }

          // Filter by count
          const count = currentDeck.filter(c => c.title === card.title).length
          return count < card.maxAmount
        },
        renderButtonText: (card) => {
          const count = currentDeck.filter(c => c.title === card.title).length
          if (count >= card.maxAmount) {
            return `Max Reached <small>(${count}/${card.maxAmount})</small>`
          }
          return `Add Card <small>(${count}/${card.maxAmount})</small>`
        }
      }
    )

    // Enable the generate button
    generateDeckBtn.disabled = false

    // Load validation model
    try {
      console.log('Loading validation model...')
      await manager.loadValidationModel('training_data/deck-validator-model/model.json')
      console.log('Validation model loaded!')
    } catch (e) {
      console.warn('Validation model not available:', e)
    }
  } catch (e) {
    console.error('Failed to load model:', e)
    alert('Failed to load AI model. Please refresh the page.')
  }

  function checkDualInks (card, inks) {
    if (inks.length !== 2 || !card.inks) {
      return false
    }
    return inks.includes(card.inks[0]) && inks.includes(card.inks[1])
  }

  function addCardToDeck (card) {
    if (currentDeck.length >= 60) {
      alert('Deck is full (60 cards).')
      return
    }
    // Check limit
    const count = currentDeck.filter(c => c.title === card.title).length
    if (count >= card.maxAmount) {
      alert(`Cannot add more than ${card.maxAmount} copies of this card.`)
      return
    }

    currentDeck.push(card)
    updateDeckPreview()
    cardSelector.refresh() // Update counts
  }

  generateDeckBtn.addEventListener('click', async () => {
    generateDeckBtn.disabled = true
    const legalOnly = legalOnlyCheckbox.checked

    // Loop until 60 cards
    while (currentDeck.length < 60) {
      const names = currentDeck.map(c => c.version ? `${c.name} - ${c.version}` : c.name)
      const prediction = await manager.predict(names, legalOnly, currentInks)

      if (prediction && typeof prediction !== 'string') {
        currentDeck.push(prediction)
        updateDeckPreview()

        // Small delay to prevent UI freeze
        await new Promise(resolve => setTimeout(resolve, 10))
      } else {
        console.warn('No valid prediction:', prediction)
        break // Break if we can't find a valid card
      }
    }

    generateDeckBtn.disabled = false
  })

  clearDeckBtn.addEventListener('click', () => {
    currentDeck = []
    updateDeckPreview()
    testDeckBtn.classList.add('hidden')
  })

  testDeckBtn.addEventListener('click', () => {
    window.open(getInkTableLink(), '_blank')
  })

  function getInkTableLink () {
    const randomId = Math.random().toString(36).substring(7)
    let deckName = `AI Generated Deck: ${currentInks[0]} - ${currentInks[1]} - ${randomId}`
    deckName = encodeURIComponent(deckName)
    let base64Id = ''
    const uniqueCardsInDeck = [...new Set(currentDeck.map(card => card.title))]
    for (const card of uniqueCardsInDeck) {
      const amountOfCardsWithSameTitle = currentDeck.filter(deckCard => deckCard.title === card).length
      base64Id += `${card}$${amountOfCardsWithSameTitle}|`
    }

    return `https://inktable.net/lor/import?svc=dreamborn&name=${deckName}&id=${btoa(base64Id)}`
  }

  function updateDeckPreview () {
    // Render deck with current inks for sorting preference
    deckRenderer.render(currentDeck, currentInks)

    // Toggle test button based on deck state
    testDeckBtn.classList.remove('hidden')
    if (currentDeck.length < 60) {
      testDeckBtn.classList.add('hidden')
    }

    // Update chart
    if (currentDeck.length > 0) {
      chart.renderChart(currentDeck)
    } else {
      chart.renderChart([])
    }

    // Update validation score
    updateValidationScore()
  }

  async function updateValidationScore () {
    console.log('updateValidationScore called, deck length:', currentDeck.length)

    const validationContainer = document.querySelector('[data-role="validation-score"]')
    if (!validationContainer) {
      console.warn('Validation container not found')
      return
    }

    if (currentDeck.length < 60) {
      validationContainer.innerHTML = `
                <div class="validation-card">
                    <div class="validation-header">
                        <h3>Deck Realism</h3>
                        <span class="validation-grade grade-empty">-</span>
                    </div>
                    <div class="validation-message">Add ${60 - currentDeck.length} more cards</div>
                </div>
            `
      return
    }

    try {
      console.log('Calling manager.validateDeck...')
      const result = await manager.validateDeck(currentDeck)
      console.log('Validation result received:', result)

      if (!result) {
        validationContainer.innerHTML = ''
        return
      }

      const scorePercent = Math.round(result.score * 100)
      const gradeClass = result.grade === 'A'
        ? 'grade-a'
        : result.grade === 'B'
          ? 'grade-b'
          : result.grade === 'C' ? 'grade-c' : 'grade-d'

      let breakdownHTML = ''
      if (result.breakdown && result.breakdown.length > 0) {
        breakdownHTML = '<div class="validation-breakdown">'
        breakdownHTML += '<h4>Analysis:</h4>'
        breakdownHTML += '<ul>'
        result.breakdown.forEach(issue => {
          let severityClass = 'severity-medium'
          if (issue.severity === 'high') severityClass = 'severity-high'
          if (issue.severity === 'info') severityClass = 'severity-info'

          breakdownHTML += `<li class="${severityClass}"><strong>${issue.issue}:</strong> ${issue.message}</li>`
        })
        breakdownHTML += '</ul></div>'
      }

      validationContainer.innerHTML = `
                <div class="validation-card">
                    <div class="validation-header">
                        <h3>Deck Realism</h3>
                        <span class="validation-grade ${gradeClass}">${result.grade}</span>
                    </div>
                    <div class="validation-score">${scorePercent}%</div>
                    <div class="validation-message">${result.message}</div>
                    ${breakdownHTML}
                </div>
            `
    } catch (error) {
      console.error('Error in updateValidationScore:', error)
      validationContainer.innerHTML = `
                <div class="validation-card">
                    <div class="validation-message" style="color: #ef4444;">
                        Error loading validation: ${error.message}
                    </div>
                </div>
            `
    }
  }
})
