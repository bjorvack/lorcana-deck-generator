#!/usr/bin/env node

/**
 * Check Distribution Script
 * Scans training_data/decks and reports the count of decks per ink combination.
 * Also tracks missing combinations and single-ink decks.
 */

const fs = require('fs')
const path = require('path')

const INKS = ['amber', 'amethyst', 'emerald', 'ruby', 'sapphire', 'steel']
const trainingDataPath = path.join(__dirname, '..', 'training_data', 'decks')

function generateAllCombinations() {
    const combinations = []
    // Single ink (mono)
    for (const ink of INKS) {
        combinations.push([ink])
    }
    // Two-ink combinations
    for (let i = 0; i < INKS.length; i++) {
        for (let j = i + 1; j < INKS.length; j++) {
            combinations.push([INKS[i], INKS[j]])
        }
    }
    return combinations
}

function getInkPath(inks) {
    return inks.slice().sort().join('-')
}

function main() {
    console.log('=== Deck Distribution Report ===\n')

    const allCombinations = generateAllCombinations()
    const distribution = new Map()

    // Initialize all combinations with 0
    for (const combo of allCombinations) {
        distribution.set(getInkPath(combo), { count: 0, inks: combo })
    }

    // Scan the decks directory
    if (!fs.existsSync(trainingDataPath)) {
        console.error('Error: training_data/decks directory not found')
        process.exit(1)
    }

    const inkDirs = fs.readdirSync(trainingDataPath)

    for (const inkDir of inkDirs) {
        const inkPath = path.join(trainingDataPath, inkDir)
        if (!fs.statSync(inkPath).isDirectory()) continue

        const deckFiles = fs.readdirSync(inkPath).filter(f => f.endsWith('.json'))
        const count = deckFiles.length

        if (distribution.has(inkDir)) {
            distribution.get(inkDir).count = count
        } else {
            // Unknown combination (shouldn't happen, but handle gracefully)
            distribution.set(inkDir, { count, inks: inkDir.split('-') })
        }
    }

    // Sort by count descending
    const sorted = Array.from(distribution.entries())
        .sort((a, b) => b[1].count - a[1].count)

    // Report: Two-ink combinations
    console.log('## Two-Ink Combinations')
    const twoInk = sorted.filter(([_, v]) => v.inks.length === 2)
    for (const [key, value] of twoInk) {
        const bar = '█'.repeat(Math.min(value.count, 50))
        console.log(`  ${key.padEnd(20)} ${String(value.count).padStart(4)} ${bar}`)
    }

    // Report: Single-ink (mono) decks
    console.log('\n## Single-Ink (Mono) Decks')
    const monoInk = sorted.filter(([_, v]) => v.inks.length === 1)
    let hasMonoDecks = false
    for (const [key, value] of monoInk) {
        if (value.count > 0) {
            hasMonoDecks = true
            console.log(`  ${key.padEnd(20)} ${String(value.count).padStart(4)}`)
        }
    }
    if (!hasMonoDecks) {
        console.log('  (none)')
    }

    // Report: Missing combinations
    console.log('\n## Missing Combinations (0 decks)')
    const missingTwoInk = sorted.filter(([_, v]) => v.count === 0 && v.inks.length === 2)
    const missingSingleInk = sorted.filter(([_, v]) => v.count === 0 && v.inks.length === 1)

    if (missingTwoInk.length === 0 && missingSingleInk.length === 0) {
        console.log('  All combinations have at least one deck!')
    } else {
        if (missingTwoInk.length > 0) {
            console.log('  Two-ink:')
            for (const [key, _] of missingTwoInk) {
                console.log(`    - ${key}`)
            }
        }
        if (missingSingleInk.length > 0) {
            console.log('  Single-ink (mono):')
            for (const [key, _] of missingSingleInk) {
                console.log(`    - ${key}`)
            }
        }
    }

    // Summary
    const totalDecks = sorted.reduce((sum, [_, v]) => sum + v.count, 0)
    const maxCount = twoInk.length > 0 ? twoInk[0][1].count : 0
    const minCount = twoInk.length > 0 ? twoInk[twoInk.length - 1][1].count : 0

    console.log('\n## Summary')
    console.log(`  Total decks: ${totalDecks}`)
    console.log(`  Most common: ${twoInk[0]?.[0] || 'N/A'} (${maxCount})`)
    console.log(`  Least common: ${twoInk[twoInk.length - 1]?.[0] || 'N/A'} (${minCount})`)
    console.log(`  Missing combinations: ${missingTwoInk.length + missingSingleInk.length}`)

    if (maxCount > 0 && minCount > 0) {
        console.log(`  Imbalance ratio: ${(maxCount / minCount).toFixed(1)}x`)
    }
}

main()
