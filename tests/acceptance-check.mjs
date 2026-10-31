#!/usr/bin/env node
// Checks a finished swarm-sim run against the automatic acceptance criteria
// (spec "Acceptance run", criteria 1, 5, 6, 7 and 8). Criteria 2 to 4 need a
// reviewer to read report.final.md against the logs.
//
// Usage: node tests/acceptance-check.mjs <runDir>

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function parseHypothesisTable(markdown) {
  const lines = markdown.split('\n')
  const header = lines.findIndex(
    (line) => line.trim().startsWith('|') && /If the listing leads with/i.test(line) && /measured by/i.test(line),
  )
  if (header === -1) return null
  const rows = []
  for (const line of lines.slice(header + 2)) {
    if (!line.trim().startsWith('|')) break
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())
    rows.push(cells)
  }
  return rows
}

export function checkRun(runDir) {
  const read = (name) => readFileSync(join(runDir, name), 'utf8')
  const results = []
  const record = (criterion, pass, detail) => results.push({ criterion, pass, detail })

  const plan = JSON.parse(read('plan.json'))
  const variantIds = (plan.variants || []).map((variant) => variant.id).sort()
  record(
    1,
    plan.mode === 'journey' && JSON.stringify(variantIds) === JSON.stringify(['A', 'B', 'baseline']),
    `mode=${plan.mode}, variants=${variantIds.join(',')}`,
  )

  const report = existsSync(join(runDir, 'report.final.md')) ? read('report.final.md') : ''
  const rows = parseHypothesisTable(report)
  const fullRows = (rows || []).filter((cells) => cells.length >= 5 && cells.slice(1, 5).every((cell) => cell !== ''))
  record(
    5,
    rows !== null && rows.length >= 3 && fullRows.length === rows.length,
    rows === null ? 'no hypothesis table found' : `${rows.length} rows, ${fullRows.length} with X, Y, Z and Citations filled`,
  )

  const finalCheckName = ['check-3.json', 'check-2.json', 'check.json'].find((name) => existsSync(join(runDir, name)))
  const finalCheck = finalCheckName ? JSON.parse(read(finalCheckName)) : null
  const violations = finalCheck?.violations?.length ?? -1
  const untraced = finalCheck?.untraced?.length ?? -1
  const checkClean = violations === 0 && untraced === 0
  record(6, checkClean, `${finalCheckName}: ${violations} violations, ${untraced} untraced`)

  const percentLines = report.split('\n').filter((line) => /[0-9]+(\.[0-9]+)? ?%/.test(line))
  record(
    7,
    report !== '' && checkClean && percentLines.length === 0,
    percentLines.length ? `percent found: ${percentLines[0].trim().slice(0, 120)}` : 'no percentages',
  )

  const rules = (plan.rules || []).join('\n')
  const hasHypothesisRule = /hypothes/i.test(rules)
  const hasCompetitorRule = /competitor/i.test(rules)
  record(
    8,
    hasHypothesisRule && hasCompetitorRule && checkClean,
    `hypothesis rule=${hasHypothesisRule}, competitor rule=${hasCompetitorRule}`,
  )

  return results
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const runDir = process.argv[2]
  if (!runDir) {
    console.error('Usage: node tests/acceptance-check.mjs <runDir>')
    process.exit(2)
  }
  const results = checkRun(runDir)
  for (const { criterion, pass, detail } of results) {
    console.log(`${pass ? 'PASS' : 'FAIL'} criterion ${criterion}: ${detail}`)
  }
  process.exit(results.every((result) => result.pass) ? 0 : 1)
}
