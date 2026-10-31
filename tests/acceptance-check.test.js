import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { checkRun, parseHypothesisTable } from './acceptance-check.mjs'

const TABLE = [
  '| # | If the listing leads with (X) | then this changes (Y) | measured by (Z) | Citations |',
  '|---|---|---|---|---|',
  '| 1 | free sharing | invites rise | invites per install | A/P-1:3 |',
  '| 2 | nap prediction | trial starts rise | trials per install | B/P-1:4 |',
  '| 3 | mixed message | onboarding drop-off rises | onboarding completion | baseline/P-2:2 |',
].join('\n')

function makeRun({ plan = {}, report = TABLE, check = { violations: [], untraced: [] }, check2 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-acceptance-'))
  writeFileSync(
    join(dir, 'plan.json'),
    JSON.stringify({
      mode: 'journey',
      variants: [{ id: 'A' }, { id: 'B' }, { id: 'baseline' }],
      rules: ['Label every speculative reason as a hypothesis.', 'Do not state competitor features beyond price as fact.'],
      ...plan,
    }),
  )
  writeFileSync(join(dir, 'report.final.md'), `# Report\n\n${report}\n`)
  writeFileSync(join(dir, 'check.json'), JSON.stringify(check))
  if (check2) writeFileSync(join(dir, 'check-2.json'), JSON.stringify(check2))
  return dir
}

const byCriterion = (results) => Object.fromEntries(results.map((r) => [r.criterion, r.pass]))

test('a clean run passes every automatic criterion', () => {
  assert.deepEqual(byCriterion(checkRun(makeRun())), { 1: true, 5: true, 6: true, 7: true, 8: true })
})

test('social mode or a missing variant fails criterion 1', () => {
  assert.equal(byCriterion(checkRun(makeRun({ plan: { mode: 'social' } })))[1], false)
  assert.equal(byCriterion(checkRun(makeRun({ plan: { variants: [{ id: 'A' }, { id: 'B' }] } })))[1], false)
})

test('fewer than 3 rows or an empty cell fails criterion 5', () => {
  const twoRows = TABLE.split('\n').slice(0, 4).join('\n')
  assert.equal(byCriterion(checkRun(makeRun({ report: twoRows })))[5], false)
  const emptyZ = TABLE.replace('| invites per install |', '|  |')
  assert.equal(byCriterion(checkRun(makeRun({ report: emptyZ })))[5], false)
})

test('check-2 takes precedence over check for criterion 6', () => {
  const dirty = { violations: [{ rule: 'r', quote: 'q', fix: 'f' }], untraced: [] }
  assert.equal(byCriterion(checkRun(makeRun({ check: dirty, check2: { violations: [], untraced: [] } })))[6], true)
  assert.equal(byCriterion(checkRun(makeRun({ check2: { violations: [], untraced: ['claim'] } })))[6], false)
})

test('a percentage in the report fails criterion 7', () => {
  assert.equal(byCriterion(checkRun(makeRun({ report: `${TABLE}\n\nTrials rise 12%.` })))[7], false)
})

test('naming conversion rate as a metric does not fail criterion 7', () => {
  const named = TABLE.replace('trials per install', 'product page conversion rate')
  assert.equal(byCriterion(checkRun(makeRun({ report: named })))[7], true)
})

test('missing hypothesis or competitor rule fails criterion 8', () => {
  assert.equal(byCriterion(checkRun(makeRun({ plan: { rules: ['Cite every claim.'] } })))[8], false)
})

test('parseHypothesisTable returns null without the table header', () => {
  assert.equal(parseHypothesisTable('no table here'), null)
})

test('check-3 takes precedence over check-2 for criterion 6', () => {
  const dirty = { violations: [], untraced: ['claim'] }
  const clean = { violations: [], untraced: [] }
  const withCheck3 = (check3) => {
    const dir = makeRun({ check: dirty, check2: dirty })
    writeFileSync(join(dir, 'check-3.json'), JSON.stringify(check3))
    return dir
  }
  assert.equal(byCriterion(checkRun(withCheck3(clean)))[6], true)
  assert.equal(byCriterion(checkRun(withCheck3(dirty)))[6], false)
})

test('a run folder with no check file fails criteria 6 to 8 instead of throwing', () => {
  const dir = makeRun()
  rmSync(join(dir, 'check.json'))
  const results = byCriterion(checkRun(dir))
  assert.equal(results[6], false)
  assert.equal(results[7], false)
  assert.equal(results[8], false)
})
