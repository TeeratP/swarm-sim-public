import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { run, variantTextCount } from './harness.js'

const WORKFLOW = fileURLToPath(new URL('../.claude/workflows/swarm-run.js', import.meta.url))
const fixture = (name) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/run/${name}`, import.meta.url)), 'utf8'))

const plan = fixture('plan.json')
const personaRefs = fixture('personaRefs.json')
const analysis = fixture('analysis.json')
const checkClean = fixture('check-clean.json')
const checkDirty = fixture('check-dirty.json')
const check2Dirty = fixture('check-2-dirty.json')
const REPORT = fixture('report.json')
const REVISED = fixture('revise.json')
const REVISED_2 = { markdown: '# Report, revised twice\n\nCoverage: 36 of 36 pairs completed\n' }

const RUN_DIR = '/packs/demo/runs/2026-10-31-demo'
const FACTS_PATH = `${RUN_DIR}/facts.json`
const REFS = '/repo/.claude/skills/swarm-sim/references'
const DESCRIPTIONS = plan.variants.map((v) => v.description)

const makeArgs = (overrides = {}) => ({
  packDir: '/packs/demo',
  runDir: RUN_DIR,
  plan,
  personaRefs,
  factsPath: FACTS_PATH,
  referencesDir: REFS,
  ...overrides,
})

const planWith = (changes) => ({ ...structuredClone(plan), ...changes })

/** Actor fixture: one log line per timeline step, with a quote that names the actor's label. */
function actorResult(prompt, opts) {
  const variant = opts.label.slice('actor:'.length).split('/')[0]
  return {
    lines: plan.timeline.map((t) => ({
      step: t.step,
      variant,
      sees: `step ${t.step}`,
      decision: 'continue',
      reason: 'a reason',
      quote: `QUOTE[${opts.label}]`,
      label: 'Hypothesis',
    })),
  }
}

const makeFixtures = (overrides = {}) => ({
  'actor:': actorResult,
  'analyst:': analysis,
  report: REPORT,
  check: checkClean,
  revise: REVISED,
  'check-2': checkClean,
  'revise-2': REVISED_2,
  'check-3': checkClean,
  ...overrides,
})

const labelsOf = (r) => r.calls.map((c) => c.opts.label)
const callsWithPrefix = (r, prefix) => r.calls.filter((c) => c.opts.label.startsWith(prefix))
const callsLabeled = (r, label) => r.calls.filter((c) => c.opts.label === label)

const NO_FILE = 'Do not write any file'

/** The report the script builds when the last check still has items: the revised text plus a Known issues section. */
const withKnownIssues = (markdown, check) =>
  `${markdown.trimEnd()}\n\n## Known issues\n\n${[
    ...check.violations.map((v) => `- ${v.rule}: ${v.quote} → ${v.fix}`),
    ...check.untraced.map((claim) => `- ${claim}`),
  ].join('\n')}\n`

async function runDirty(overrides = {}) {
  return run(WORKFLOW, {
    args: makeArgs(),
    fixtures: makeFixtures({ check: checkDirty, 'check-2': check2Dirty, ...overrides }),
  })
}

test('12 personas x 3 variants make 36 actors, 3 analysts, 1 report, 1 check and no revise when the check is clean', async () => {
  const r = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures() })
  assert.ifError(r.error)
  assert.equal(personaRefs.length, 12)
  assert.equal(plan.variants.length, 3)
  assert.equal(callsWithPrefix(r, 'actor:').length, 36)
  assert.equal(callsWithPrefix(r, 'analyst:').length, 3)
  assert.equal(callsLabeled(r, 'report').length, 1)
  assert.equal(callsLabeled(r, 'check').length, 1)
  assert.equal(callsLabeled(r, 'revise').length, 0)
  assert.equal(callsLabeled(r, 'check-2').length, 0)
  assert.equal(r.calls.length, 41)
  assert.deepEqual(r.result, {
    coverage: '36 of 36 pairs completed',
    files: { 'report.md': REPORT.markdown, 'check.json': checkClean, 'report.final.md': REPORT.markdown },
    finalCheck: checkClean,
  })
  assert.deepEqual(Object.keys(r.result.files), ['report.md', 'check.json', 'report.final.md'])
  assert.equal(Object.hasOwn(r.result, 'reportPath'), false)
  assert.deepEqual(r.logs, [])
})

test('actor labels cover every (variant, persona) pair once', async () => {
  const r = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures() })
  const expected = plan.variants.flatMap((v) => personaRefs.map((p) => `actor:${v.id}/${p.id}`))
  assert.deepEqual(callsWithPrefix(r, 'actor:').map((c) => c.opts.label).sort(), expected.sort())
})

test('exactly at the cap runs; one over the cap returns {error} before any agent call', async () => {
  const atCap = await run(WORKFLOW, {
    args: makeArgs({ plan: planWith({ budget: { simulationAgentCalls: 36, cap: 36, dropped: [] } }) }),
    fixtures: makeFixtures(),
  })
  assert.ifError(atCap.error)
  assert.equal(atCap.result.coverage, '36 of 36 pairs completed')

  const over = await run(WORKFLOW, {
    args: makeArgs({ plan: planWith({ budget: { simulationAgentCalls: 36, cap: 35, dropped: [] } }) }),
    fixtures: makeFixtures(),
  })
  assert.ifError(over.error)
  assert.match(over.result.error, /36.*exceeds plan\.budget\.cap of 35/)
  assert.equal(Object.keys(over.result).length, 1)
  assert.equal(over.calls.length, 0)
})

test('a missing or non-numeric cap returns {error} before any agent call', async () => {
  for (const budget of [undefined, {}, { cap: '60' }, { cap: null }]) {
    const r = await run(WORKFLOW, { args: makeArgs({ plan: planWith({ budget }) }), fixtures: makeFixtures() })
    assert.ifError(r.error)
    assert.match(r.result.error, /plan\.budget\.cap is missing or not a number/)
    assert.equal(r.calls.length, 0)
  }
})

test('every actor prompt contains exactly one variant description and nothing from the other variants', async () => {
  const r = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures() })
  const actorCalls = callsWithPrefix(r, 'actor:')
  assert.equal(actorCalls.length, 36)
  for (const call of actorCalls) {
    const [variantId, personaId] = call.opts.label.slice('actor:'.length).split('/')
    const own = plan.variants.find((v) => v.id === variantId)
    const persona = personaRefs.find((p) => p.id === personaId)
    const prompt = call.prompt

    assert.equal(variantTextCount(prompt, DESCRIPTIONS), 1, call.opts.label)
    assert.ok(prompt.includes(own.description), call.opts.label)
    for (const other of plan.variants.filter((v) => v.id !== variantId)) {
      assert.ok(!prompt.toLowerCase().includes(other.id), `${call.opts.label} leaks id ${other.id}`)
      assert.ok(!prompt.includes(other.label), `${call.opts.label} leaks label ${other.label}`)
      assert.ok(!prompt.includes(other.description), `${call.opts.label} leaks description`)
    }

    assert.ok(prompt.includes(JSON.stringify(plan.timeline, null, 2)), 'timeline inline')
    assert.ok(prompt.includes(`${RUN_DIR}/sim/${variantId}/${personaId}.jsonl`), 'log path')
    assert.match(prompt, /Do not read the scenario file, plan\.json, or any other persona file/)
    assert.match(prompt, /\{lines: \[\.\.\.\]\}/)
  }
})

test('every actor prompt points at its own persona file and the facts file, and allows reading only those two', async () => {
  const r = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures() })
  const actorCalls = callsWithPrefix(r, 'actor:')
  assert.equal(actorCalls.length, 36)
  for (const call of actorCalls) {
    const personaId = call.opts.label.slice('actor:'.length).split('/')[1]
    const own = personaRefs.find((p) => p.id === personaId)
    const prompt = call.prompt

    assert.ok(prompt.includes(own.path), `${call.opts.label}: persona path`)
    assert.ok(prompt.includes(FACTS_PATH), `${call.opts.label}: facts path`)
    assert.match(prompt, /Read exactly these two files and no other file/)
    for (const other of personaRefs.filter((p) => p.id !== personaId)) {
      assert.ok(!prompt.includes(other.path), `${call.opts.label} names ${other.path}`)
    }
    // Personas and facts are read from disk, so the prompt holds none of their content.
    assert.ok(!prompt.includes('"cohortId"') && !prompt.includes('"relatedIds"'), `${call.opts.label}: no persona JSON`)
  }
})

test('one null actor gives 35 of 36, a log line naming it, and an analyst prompt that leaves it out', async () => {
  const dead = 'actor:bravo/cohort-night-2'
  const r = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures({ [dead]: null }) })
  assert.ifError(r.error)
  assert.equal(r.result.coverage, '35 of 36 pairs completed')
  assert.equal(r.logs.filter((line) => line.includes(dead)).length, 1)
  assert.equal(r.logs.length, 1)

  const bravo = callsLabeled(r, 'analyst:bravo')[0].prompt
  assert.ok(!bravo.includes(`QUOTE[${dead}]`))
  assert.ok(!bravo.includes('"cohort-night-2"'))
  assert.equal(bravo.split('QUOTE[actor:bravo/').length - 1, 11 * plan.timeline.length)

  // The same persona still completed under the other variants.
  const alpha = callsLabeled(r, 'analyst:alpha')[0].prompt
  assert.ok(alpha.includes('QUOTE[actor:alpha/cohort-night-2]'))
  assert.equal(callsWithPrefix(r, 'analyst:').length, 3)
})

test('the analyst gets non-null actor results keyed by persona id with each cohortId, and writes its analysis file', async () => {
  const r = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures() })
  for (const variant of plan.variants) {
    const call = callsLabeled(r, `analyst:${variant.id}`)[0]
    const logs = {}
    for (const p of personaRefs) {
      logs[p.id] = { cohortId: p.cohortId, lines: actorResult('', { label: `actor:${variant.id}/${p.id}` }).lines }
    }
    assert.ok(call.prompt.includes(JSON.stringify(logs, null, 2)), variant.id)
    assert.ok(call.prompt.includes(`${RUN_DIR}/analysis/${variant.id}.json`), variant.id)
    assert.ok(call.prompt.includes(`${variant.id}/<personaId>:<step>`), variant.id)
  }
})

test('a variant whose actors all failed gets no analyst and is called out to the report', async () => {
  const r = await run(WORKFLOW, {
    args: makeArgs(),
    fixtures: makeFixtures({
      'actor:': (prompt, opts) => (opts.label.startsWith('actor:charlie/') ? null : actorResult(prompt, opts)),
    }),
  })
  assert.ifError(r.error)
  assert.equal(r.result.coverage, '24 of 36 pairs completed')
  assert.equal(callsWithPrefix(r, 'analyst:').length, 2)
  assert.equal(callsLabeled(r, 'analyst:charlie').length, 0)
  assert.equal(r.logs.filter((line) => line.startsWith('actor returned null')).length, 12)
  assert.ok(r.logs.some((line) => line.includes('no analysis for variant charlie')))
  const reportPrompt = callsLabeled(r, 'report')[0].prompt
  assert.match(reportPrompt, /No analysis exists for variant\(s\): charlie/)
  assert.ok(reportPrompt.includes('"charlie": null'))
})

test('when no variant gets an analysis it returns {error} and writes no report', async () => {
  const r = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures({ 'analyst:': null }) })
  assert.ifError(r.error)
  assert.match(r.result.error, /no analysis was produced for any variant \(36 of 36 pairs completed\)/)
  assert.equal(r.result.coverage, '36 of 36 pairs completed')
  assert.equal(callsLabeled(r, 'report').length, 0)
  assert.equal(r.logs.filter((line) => line.startsWith('no analysis for variant')).length, 3)
})

test('the report prompt carries all analyses, expected outputs, coverage, the table format and the reference files', async () => {
  const r = await run(WORKFLOW, {
    args: makeArgs(),
    fixtures: makeFixtures({ 'actor:alpha/cohort-first-1': null }),
  })
  const prompt = callsLabeled(r, 'report')[0].prompt
  const analyses = { alpha: analysis, bravo: analysis, charlie: analysis }
  assert.ok(prompt.includes(JSON.stringify(analyses, null, 2)))
  for (const output of plan.expectedOutputs) assert.ok(prompt.includes(output), output)
  for (const rule of plan.rules) assert.ok(prompt.includes(rule), rule)
  for (const variant of plan.variants) assert.ok(prompt.includes(variant.description), variant.id)
  assert.ok(prompt.includes('Coverage: 35 of 36 pairs completed'))
  assert.ok(prompt.includes('| # | If the listing leads with (X) | then this changes (Y) | measured by (Z) | Citations |'))
  assert.ok(prompt.includes('|---|---|---|---|---|'))
  assert.ok(prompt.includes(`${REFS}/formats.md`))
  assert.ok(prompt.includes(`${REFS}/rules.md`))
  assert.match(prompt, /citation in the format <variant>\/<personaId>:<step>/)
  assert.ok(prompt.includes(NO_FILE))
  assert.ok(prompt.includes('Return the full report as `markdown`'))
  assert.ok(!prompt.includes('report.md') && !prompt.includes('report.final.md'), 'no report file is named')
  assert.ok(!/Write it to/.test(prompt))
})

test('the check prompt carries the report text inline, plan.rules, both citation formats and no file to write', async () => {
  const r = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures() })
  const prompt = callsLabeled(r, 'check')[0].prompt
  for (const rule of plan.rules) assert.ok(prompt.includes(rule), rule)
  assert.ok(prompt.includes('<variant>/<personaId>:<step>'))
  assert.ok(prompt.includes('<variant>/round-<n>/<actionId>'))
  assert.ok(prompt.includes(REPORT.markdown))
  assert.ok(prompt.includes(`You may read the simulation logs under ${RUN_DIR}/sim/ to verify citations`))
  assert.ok(prompt.includes(NO_FILE))
  assert.ok(prompt.includes('Return {violations, untraced}'))
  for (const name of ['report.md', 'report.final.md', 'check.json']) assert.ok(!prompt.includes(name), `names ${name}`)
  assert.ok(!/\bcopy\b/.test(prompt))
  assert.ok(prompt.includes('Coverage: 36 of 36 pairs completed'))
})

test('a dirty check-2 triggers one more revise and check-3, then stops even when check-3 is dirty', async () => {
  const r = await runDirty({ 'check-3': check2Dirty })
  assert.ifError(r.error)
  for (const label of ['check', 'revise', 'check-2', 'revise-2', 'check-3']) assert.equal(callsLabeled(r, label).length, 1, label)
  assert.deepEqual(labelsOf(r).slice(-6), ['report', 'check', 'revise', 'check-2', 'revise-2', 'check-3'])
  assert.deepEqual(r.result, {
    coverage: '36 of 36 pairs completed',
    files: {
      'report.md': REPORT.markdown,
      'check.json': checkDirty,
      'report.final.md': withKnownIssues(REVISED_2.markdown, check2Dirty),
      'check-2.json': check2Dirty,
      'check-3.json': check2Dirty,
    },
    finalCheck: check2Dirty,
  })
  assert.deepEqual(Object.keys(r.result.files), ['report.md', 'check.json', 'report.final.md', 'check-2.json', 'check-3.json'])

  const revise2 = callsLabeled(r, 'revise-2')[0].prompt
  assert.ok(revise2.includes(REVISED.markdown), 'revise-2 revises the first revision')
  assert.ok(revise2.includes(check2Dirty.untraced[0]), 'revise-2 gets the check-2 items')
  const check3 = callsLabeled(r, 'check-3')[0].prompt
  assert.ok(check3.includes(REVISED_2.markdown) && !check3.includes(REVISED.markdown), 'check-3 sees the second revision only')
  assert.equal(callsLabeled(r, 'check-3')[0].opts.model, 'opus')
  assert.equal(callsLabeled(r, 'revise-2')[0].opts.model, 'opus')
})

test('a dirty check-2 followed by a clean check-3 returns the second revision with no Known issues', async () => {
  const r = await runDirty()
  assert.ifError(r.error)
  assert.deepEqual(r.result.finalCheck, checkClean)
  assert.deepEqual(r.result.files, {
    'report.md': REPORT.markdown,
    'check.json': checkDirty,
    'report.final.md': REVISED_2.markdown,
    'check-2.json': check2Dirty,
    'check-3.json': checkClean,
  })
})

test('a dirty check triggers revise and check-2; the prompts carry the right text', async () => {
  const r = await runDirty()
  assert.ifError(r.error)
  assert.equal(callsLabeled(r, 'revise').length, 1)
  assert.equal(callsLabeled(r, 'check-2').length, 1)
  assert.equal(callsLabeled(r, 'check').length, 1)
  assert.equal(Object.hasOwn(r.result, 'reportPath'), false)
  assert.notDeepEqual(r.result.finalCheck, checkDirty)

  const revise = callsLabeled(r, 'revise')[0].prompt
  assert.ok(revise.includes(REPORT.markdown))
  assert.ok(revise.includes(checkDirty.violations[0].rule))
  assert.ok(revise.includes(checkDirty.violations[0].quote))
  assert.ok(revise.includes(checkDirty.violations[0].fix))
  assert.ok(revise.includes(checkDirty.untraced[0]))
  assert.ok(revise.includes(NO_FILE))
  assert.ok(revise.includes('Return the full revised report as `markdown`'))
  assert.match(revise, /check every other citation in the report, not only the flagged ones/)
  assert.match(revise, /\/sim\/ to verify citations/)
  for (const name of ['report.md', 'report.final.md', 'check.json']) assert.ok(!revise.includes(name), `names ${name}`)

  const check2 = callsLabeled(r, 'check-2')[0].prompt
  assert.ok(check2.includes(REVISED.markdown))
  assert.ok(!check2.includes(REPORT.markdown), 'check-2 sees the revised text only')
  assert.ok(check2.includes(`You may read the simulation logs under ${RUN_DIR}/sim/ to verify citations`))
  assert.ok(check2.includes(NO_FILE))
  assert.ok(check2.includes('Return {violations, untraced}'))
  assert.ok(check2.includes('<variant>/round-<n>/<actionId>'))
  assert.ok(!check2.includes('Known issues'), 'the script, not the agent, appends Known issues')
  for (const name of ['report.md', 'report.final.md', 'check.json', 'check-2.json']) assert.ok(!check2.includes(name), `names ${name}`)
  for (const rule of plan.rules) assert.ok(check2.includes(rule), rule)
})

test('Known issues are appended by the script exactly when the last check has items, one bullet per violation and per untraced claim', async () => {
  const dirty = await runDirty({ 'check-3': check2Dirty })
  const finalMarkdown = dirty.result.files['report.final.md']
  assert.equal(
    finalMarkdown,
    [
      REVISED_2.markdown.trimEnd(),
      '',
      '## Known issues',
      '',
      `- ${check2Dirty.untraced[0]}`,
      '',
    ].join('\n'),
  )
  assert.equal(check2Dirty.violations.length + check2Dirty.untraced.length, 1)

  // Violations first as `rule: quote → fix`, then untraced claims: one bullet each, in that order.
  const two = { violations: [{ rule: 'R1', quote: 'Q1', fix: 'F1' }, { rule: 'R2', quote: 'Q2', fix: 'F2' }], untraced: ['U1', 'U2'] }
  const many = await runDirty({ 'check-3': two })
  assert.ok(many.result.files['report.final.md'].endsWith('## Known issues\n\n- R1: Q1 → F1\n- R2: Q2 → F2\n- U1\n- U2\n'))
  const onlyUntraced = await runDirty({ 'check-3': { violations: [], untraced: ['U1'] } })
  assert.ok(onlyUntraced.result.files['report.final.md'].endsWith('## Known issues\n\n- U1\n'))

  // A clean check-2 or check-3, and a clean first check, add no section.
  const clean = await runDirty({ 'check-2': checkClean })
  assert.equal(clean.result.files['report.final.md'], REVISED.markdown)
  assert.deepEqual(clean.result.files['check-2.json'], checkClean)
  const noRevise = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures() })
  assert.ok(!noRevise.result.files['report.final.md'].includes('Known issues'))
  assert.ok(!REPORT.markdown.includes('Known issues') && !REVISED.markdown.includes('Known issues'))
  assert.equal((await runDirty()).result.files['report.final.md'], REVISED_2.markdown)
})

test('a clean check-2 after a revision is returned as finalCheck, with the revised report as the final one', async () => {
  const r = await runDirty({ 'check-2': checkClean })
  assert.ifError(r.error)
  assert.deepEqual(r.result.finalCheck, checkClean)
  assert.deepEqual(r.result.files, {
    'report.md': REPORT.markdown,
    'check.json': checkDirty,
    'report.final.md': REVISED.markdown,
    'check-2.json': checkClean,
  })
})

test('a null check returns {error} and runs no revise or check-2', async () => {
  const r = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures({ check: null }) })
  assert.ifError(r.error)
  assert.match(r.result.error, /check returned null/)
  assert.deepEqual(Object.keys(r.result), ['error', 'coverage'])
  assert.equal(r.result.coverage, '36 of 36 pairs completed')
  assert.equal(callsLabeled(r, 'revise').length, 0)
  assert.equal(callsLabeled(r, 'check-2').length, 0)
})

test('a null report, or one with no markdown text, returns {error} with coverage and runs no check', async () => {
  for (const report of [null, {}, { markdown: null }, { markdown: '' }, { markdown: ' \n ' }, { markdown: 42 }, { markdown: ['text'] }]) {
    const r = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures({ report }) })
    assert.ifError(r.error)
    assert.match(r.result.error, /report returned null or no markdown text/, JSON.stringify(report))
    assert.deepEqual(Object.keys(r.result), ['error', 'coverage'])
    assert.equal(r.result.coverage, '36 of 36 pairs completed')
    assert.equal(callsLabeled(r, 'check').length, 0)
  }
})

test('a null reviser, or one with no markdown text, returns {error} with the checked report and runs no check-2', async () => {
  for (const revise of [null, {}, { markdown: '' }, { markdown: '  ' }, { markdown: 7 }]) {
    const r = await runDirty({ revise })
    assert.ifError(r.error)
    assert.match(r.result.error, /revise returned null or no markdown text/, JSON.stringify(revise))
    assert.deepEqual(Object.keys(r.result), ['error', 'coverage', 'files'])
    assert.equal(r.result.coverage, '36 of 36 pairs completed')
    assert.deepEqual(r.result.files, {
      'report.md': REPORT.markdown,
      'check.json': checkDirty,
      'report.final.md': withKnownIssues(REPORT.markdown, checkDirty),
    })
    assert.equal(callsLabeled(r, 'check-2').length, 0)
  }
})

test('a null check-2 returns {error} with the last checked report and its Known issues, never the unchecked revision', async () => {
  const r = await runDirty({ 'check-2': null })
  assert.ifError(r.error)
  assert.match(r.result.error, /check-2 returned null/)
  assert.deepEqual(r.result, {
    error: r.result.error,
    coverage: '36 of 36 pairs completed',
    files: { 'report.md': REPORT.markdown, 'check.json': checkDirty, 'report.final.md': withKnownIssues(REPORT.markdown, checkDirty) },
  })
  assert.equal(r.result.finalCheck, undefined)
})

test('a null revise-2 or check-3 returns {error} with check-2 and the first revision plus its Known issues', async () => {
  for (const overrides of [{ 'revise-2': null }, { 'revise-2': { markdown: '' } }, { 'check-3': null }]) {
    const r = await runDirty(overrides)
    assert.ifError(r.error)
    assert.match(r.result.error, /(revise-2 returned null or no markdown text|check-3 returned null)/, JSON.stringify(overrides))
    assert.deepEqual(r.result.files, {
      'report.md': REPORT.markdown,
      'check.json': checkDirty,
      'report.final.md': withKnownIssues(REVISED.markdown, check2Dirty),
      'check-2.json': check2Dirty,
    }, JSON.stringify(overrides))
    assert.equal(r.result.finalCheck, undefined)
  }
})

test('model per label: report, check and every revise and re-check are opus, analysts are opus, only actors are sonnet, and every call has a label and a schema', async () => {
  const r = await runDirty()
  assert.ifError(r.error)
  assert.equal(r.calls.length, 36 + 3 + 6)
  const opus = ['report', 'check', 'revise', 'check-2', 'revise-2', 'check-3']
  for (const call of r.calls) {
    assert.equal(typeof call.opts.label, 'string')
    assert.ok(call.opts.label.length > 0)
    assert.equal(call.opts.model, call.opts.label.startsWith('actor:') ? 'sonnet' : 'opus', call.opts.label)
    assert.ok(call.opts.schema, `${call.opts.label} has no schema`)
  }
  for (const label of opus) assert.equal(callsLabeled(r, label)[0].opts.model, 'opus', label)
  for (const call of callsWithPrefix(r, 'actor:')) assert.equal(call.opts.model, 'sonnet', call.opts.label)
  for (const call of callsWithPrefix(r, 'analyst:')) assert.equal(call.opts.model, 'opus', call.opts.label)
})

function assertSchemaShape(schema, where) {
  assert.ok(schema && typeof schema === 'object', where)
  if (schema.type === 'object') {
    assert.ok(schema.properties && typeof schema.properties === 'object', `${where}: properties`)
    assert.ok(Array.isArray(schema.required), `${where}: required`)
    for (const key of schema.required) assert.ok(key in schema.properties, `${where}: required "${key}" not in properties`)
    for (const [key, child] of Object.entries(schema.properties)) assertSchemaShape(child, `${where}.${key}`)
  } else if (schema.type === 'array') {
    assertSchemaShape(schema.items, `${where}[]`)
  }
}

test('every schema has an object root and required is a subset of properties', async () => {
  const r = await runDirty()
  const seen = new Set()
  for (const call of r.calls) {
    assert.equal(call.opts.schema.type, 'object', call.opts.label)
    const family = call.opts.label.split(':')[0]
    if (seen.has(family)) continue
    seen.add(family)
    assertSchemaShape(call.opts.schema, family)
  }
  assert.deepEqual([...seen].sort(), ['actor', 'analyst', 'check', 'check-2', 'check-3', 'report', 'revise', 'revise-2'])

  // The report and the revision come back as text, not as a path to a file.
  for (const label of ['report', 'revise']) {
    const schema = callsLabeled(r, label)[0].opts.schema
    assert.deepEqual(schema.required, ['markdown'], label)
    assert.deepEqual(Object.keys(schema.properties), ['markdown'], label)
  }
})

test('meta names the workflow and every phase used, by phase() or opts.phase, is in meta.phases', async () => {
  const r = await runDirty()
  const titles = r.meta.phases.map((p) => p.title)
  assert.equal(r.meta.name, 'swarm-run')
  assert.equal(typeof r.meta.description, 'string')
  assert.ok(!r.meta.description.includes('\n'))
  assert.deepEqual(titles, ['Simulate', 'Analyze', 'Report', 'Check'])

  for (const title of r.phases) assert.ok(titles.includes(title), `phase() title "${title}"`)
  for (const call of r.calls) assert.ok(titles.includes(call.phase), `${call.opts.label} phase "${call.phase}"`)
  assert.deepEqual([...new Set(r.calls.map((c) => c.phase))].sort(), [...titles].sort())

  const phaseOf = (label) => r.calls.find((c) => c.opts.label === label).phase
  assert.equal(phaseOf('actor:alpha/cohort-first-1'), 'Simulate')
  assert.equal(phaseOf('analyst:alpha'), 'Analyze')
  assert.equal(phaseOf('report'), 'Report')
  for (const label of ['check', 'revise', 'check-2']) assert.equal(phaseOf(label), 'Check')
})

test('actor and analyst calls pass their phase explicitly, not through phase()', async () => {
  const r = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures() })
  for (const call of r.calls.filter((c) => /^(actor|analyst):/.test(c.opts.label))) {
    assert.ok(['Simulate', 'Analyze'].includes(call.opts.phase), call.opts.label)
  }
})

test('a trailing slash on runDir does not leak into paths', async () => {
  const r = await run(WORKFLOW, { args: makeArgs({ runDir: `${RUN_DIR}/` }), fixtures: makeFixtures() })
  assert.ifError(r.error)
  assert.equal(r.result.files['report.final.md'], REPORT.markdown)
  assert.ok(callsLabeled(r, 'check')[0].prompt.includes(`${RUN_DIR}/sim/`))
  for (const call of r.calls) assert.ok(!call.prompt.includes('//sim') && !call.prompt.includes('//report'), call.opts.label)
})

test('missing or malformed personaRefs or factsPath returns {error} without calling any agent', async () => {
  const refs = personaRefs.slice(0, 2)
  const cases = [
    [{ personaRefs: undefined }, /args\.personaRefs must be an array of \{id, cohortId, path\}/],
    [{ personaRefs: 'personas' }, /args\.personaRefs/],
    [{ personaRefs: { ...refs } }, /args\.personaRefs/],
    [{ personaRefs: [null] }, /args\.personaRefs/],
    [{ personaRefs: [{ id: 'a', cohortId: 'c' }] }, /args\.personaRefs/],
    [{ personaRefs: [{ id: 'a', path: '/p/a.json' }] }, /args\.personaRefs/],
    [{ personaRefs: [{ id: 1, cohortId: 'c', path: '/p/a.json' }] }, /args\.personaRefs/],
    [{ personaRefs: [...refs, { id: 'b', cohortId: 'c', path: 7 }] }, /args\.personaRefs/],
    [{ factsPath: undefined }, /args\.factsPath must be a string/],
    [{ factsPath: 42 }, /args\.factsPath must be a string/],
    [{ factsPath: ['/f.json'] }, /args\.factsPath must be a string/],
  ]
  for (const [overrides, pattern] of cases) {
    const r = await run(WORKFLOW, { args: makeArgs(overrides), fixtures: makeFixtures() })
    assert.ifError(r.error)
    assert.match(r.result.error, pattern, JSON.stringify(overrides))
    assert.deepEqual(Object.keys(r.result), ['error'])
    assert.equal(r.calls.length, 0)
  }

  // The old inline args are not accepted in place of the references.
  const { personaRefs: _refs, factsPath: _path, ...rest } = makeArgs()
  const legacy = await run(WORKFLOW, { args: { ...rest, personas: personaRefs, facts: [] }, fixtures: makeFixtures() })
  assert.match(legacy.result.error, /args\.personaRefs/)
  assert.equal(legacy.calls.length, 0)

  // An empty list is a valid array of refs: nothing to simulate, so no actor runs.
  const empty = await run(WORKFLOW, { args: makeArgs({ personaRefs: [] }), fixtures: makeFixtures() })
  assert.equal(callsWithPrefix(empty, 'actor:').length, 0)
})

test('an unknown mode returns {error} without calling any agent', async () => {
  const r = await run(WORKFLOW, { args: makeArgs({ plan: planWith({ mode: 'orbital' }) }), fixtures: makeFixtures() })
  assert.ifError(r.error)
  assert.deepEqual(r.result, { error: 'unknown plan.mode: orbital' })
  assert.equal(r.calls.length, 0)
})

test('the script source starts with a literal meta and uses no forbidden APIs', () => {
  const source = readFileSync(WORKFLOW, 'utf8')
  assert.ok(source.startsWith('export const meta = {'))
  assert.equal(source.match(/\bexport\b/g).length, 1)
  for (const forbidden of ['Date.now', 'Math.random', 'new Date()', 'import ', 'require(']) {
    assert.ok(!source.includes(forbidden), `source contains "${forbidden}"`)
  }
})

test('report, check and revise prompts accept variant:<id> for restated variant wording, with the variants inline', async () => {
  const r = await runDirty()
  for (const label of ['report', 'check', 'revise', 'check-2']) {
    const prompt = callsLabeled(r, label)[0].prompt
    assert.ok(prompt.includes('variant:<id>'), `${label}: variant citation`)
    for (const variant of plan.variants) assert.ok(prompt.includes(variant.description), `${label}: ${variant.id}`)
  }
})

test('report and revise prompts keep a log-cited claim to what its line says', async () => {
  const r = await runDirty()
  for (const label of ['report', 'revise']) {
    assert.match(callsLabeled(r, label)[0].prompt, /says only what that line says/, label)
  }
})
