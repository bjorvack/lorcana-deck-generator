import { Chart as ChartJS } from 'chart.js/auto'

export default class Chart
{
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
            const cardsOfInk = deck.filter(card => card.ink === ink)
            const costCounts = Array.from({ length: 11 }, () => 0)
            for (const card of cardsOfInk) {
                costCounts[card.cost]++
            }

            datasets.push({
                label: ink,
                data: costCounts,
                backgroundColor: colors[ink],
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
                options:{
                    scales: {
                        x: {
                            stacked: true
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