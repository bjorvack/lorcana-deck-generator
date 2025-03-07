import { Chart as ChartJS } from 'chart.js/auto'
import pattern from 'patternomaly'

export default class Chart {
  constructor(canvas) {
    this.canvas = canvas
  }

  renderChart(deck) {
    if (this.canvas.chart !== undefined) {
      this.canvas.chart.destroy()
    }

    this.canvas.parentElement.classList.remove('hidden')

    const datasets = []
    const uniqueInks = [...new Set(deck.map(card => card.ink))].sort()

    const colors = {
      Amber: '#FFC107',
      Amethyst: '#9C27B0',
      Emerald: '#4CAF50',
      Ruby: '#F44336',
      Sapphire: '#2196F3',
      Steel: '#607D8B',
    }

    for (const ink of uniqueInks) {
      const cardsOfInk = deck.filter(card => card.ink === ink || card.inks?.includes(ink))
      const inkableCostCounts = Array.from({ length: 11 }, () => 0)
      const nonInkableCostCounts = Array.from({ length: 11 }, () => 0)
      for (const card of cardsOfInk) {
        if (card.inkwell) {
          inkableCostCounts[card.cost]++

          continue
        }

        nonInkableCostCounts[card.cost]++
      }

      datasets.push({
        label: ink,
        data: inkableCostCounts,
        backgroundColor: colors[ink],
      })

      datasets.push({
        label: `${ink} (Non-Inkable)`,
        data: nonInkableCostCounts,
        backgroundColor: pattern.draw('diagonal', colors[ink]),
      })
    }

    this.canvas.chart = new ChartJS(
      this.canvas,
      {
        type: 'bar',
        data: {
          labels: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
          datasets: datasets
        },
        options: {
          scales: {
            x: {
              stacked: true,
            },
            y: {
              stacked: true
            }
          }
        }
      }
    )
  }
}
