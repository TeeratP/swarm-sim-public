import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { run, variantTextCount } from './harness.js'

const WORKFLOW = fileURLToPath(new URL('../.claude/workflows/swarm-run.js', import.meta.url))
const fixture = (name) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/run/${name}`, import.meta.url)), 'utf8'))

const plan = fixture('social/plan.json')
const personaRefs = fixture('social/personaRefs.json')
const analysis = fixture('social/analysis.json')
const checkClean = fixture('check-clean.json')
const checkDirty = fixture('check-dirty.json')
const check2Dirty = fixture('check-2-dirty.json')
const REPORT = fixture('report.json')
const REVISED = fixture('revise.json')
const scenarioRich = fixture('social/scenario-rich.json')
const scenarioThreads = fixture('social/scenario-threads.json')
const scenarioInvalid = fixture('social/scenario-invalid.json')

const RUN_DIR = '/packs/demo/runs/2026-10-31-demo'
const FACTS_PATH = `${RUN_DIR}/facts.json`
const REFS = '/repo/.claude/skills/swarm-sim/references'
const EMPTY_FEED = '(empty: nothing has been posted yet)'
const DESCRIPTIONS = plan.variants.map((v) => v.description)
const VARIANT_IDS = plan.variants.map((v) => v.id)

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

const batchOf = (k, list = personaRefs) => list.slice(4 * k, 4 * k + 4)

/** Scenario files hold "@V" where the variant id goes, so one file serves every variant. */
const forVariant = (value, variantId) => JSON.parse(JSON.stringify(value).replaceAll('@V', variantId))

/** Default batch result: one post per persona in the batch, with text that names the call. */
function defaultBatch(variantId, round, batch) {
  const label = `social:${variantId}/r${round}/b${batch}`
  return {
    actions: batchOf(batch).map((persona, i) => ({
      id: `r${round}-b${batch}-${i}`,
      personaId: persona.id,
      type: 'post',
      targetId: '',
      text: `TEXT[${label}#${i}]`,
      label: 'Hypothesis',
    })),
  }
}

/**
 * Social fixture: a scenario's result for the exact label, else for the "@V" form of the label,
 * else the default batch. A scenario value of null means the batch returns null.
 */
function socialResponder(scenario = {}) {
  return (prompt, opts) => {
    const [, variantId, round, batch] = /^social:([^/]+)\/r(\d+)\/b(\d+)$/.exec(opts.label)
    for (const key of [opts.label, `social:@V/r${round}/b${batch}`]) {
      if (Object.hasOwn(scenario, key)) return forVariant(scenario[key], variantId)
    }
    return defaultBatch(variantId, Number(round), Number(batch))
  }
}

const makeFixtures = ({ scenario, ...overrides } = {}) => ({
  'social:': socialResponder(scenario),
  'analyst:': analysis,
  report: REPORT,
  check: checkClean,
  revise: REVISED,
  'check-2': checkClean,
  'revise-2': REVISED_2,
  'check-3': checkClean,
  ...overrides,
})

const REVISED_2 = { markdown: '# Social report, revised twice\n' }

const labelsOf = (r) => r.calls.map((c) => c.opts.label)
const callsWithPrefix = (r, prefix) => r.calls.filter((c) => c.opts.label.startsWith(prefix))
const callsLabeled = (r, label) => r.calls.filter((c) => c.opts.label === label)
const socialCall = (r, variantId, round, batch) => callsLabeled(r, `social:${variantId}/r${round}/b${batch}`)[0]
const promptOf = (r, variantId, round, batch) => socialCall(r, variantId, round, batch).prompt

/** Returns the feed shown to one persona in a social prompt: its items, or [] when it reads as empty. */
function feedOf(prompt, personaId) {
  const marker = `Feed for ${personaId}:\n`
  assert.equal(prompt.split(marker).length - 1, 1, `exactly one feed for ${personaId}`)
  const rest = prompt.slice(prompt.indexOf(marker) + marker.length)
  const body = rest.slice(0, rest.indexOf('\n\n'))
  return body === EMPTY_FEED ? [] : JSON.parse(body)
}
const feedIds = (prompt, personaId) => feedOf(prompt, personaId).map((item) => item.id)

/** Returns the action list inlined in a social analyst prompt. */
function analystActions(prompt) {
  const start = prompt.indexOf('Use only these actions.\n') + 'Use only these actions.\n'.length
  return JSON.parse(prompt.slice(start, prompt.indexOf('\n\nPersona id to cohortId:')))
}

const NO_FILE = 'Do not write any file'

/** The report the script builds when check-2 still has items: the revised text plus a Known issues section. */
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

test('9 personas x 3 rounds x 2 variants make 18 social calls, 2 analysts, 1 report and 1 check', async () => {
  const r = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures() })
  assert.ifError(r.error)
  assert.equal(personaRefs.length, 9)
  assert.equal(plan.rounds, 3)
  assert.equal(plan.variants.length, 2)
  assert.equal(callsWithPrefix(r, 'social:').length, 18)
  assert.equal(callsWithPrefix(r, 'analyst:').length, 2)
  assert.equal(callsLabeled(r, 'report').length, 1)
  assert.equal(callsLabeled(r, 'check').length, 1)
  assert.equal(callsLabeled(r, 'revise').length, 0)
  assert.equal(callsLabeled(r, 'check-2').length, 0)
  assert.equal(r.calls.length, 22)
  assert.deepEqual(r.result, {
    coverage: '18 of 18 batch rounds completed',
    files: { 'report.md': REPORT.markdown, 'check.json': checkClean, 'report.final.md': REPORT.markdown },
    finalCheck: checkClean,
  })
  assert.deepEqual(Object.keys(r.result.files), ['report.md', 'check.json', 'report.final.md'])
  assert.equal(Object.hasOwn(r.result, 'reportPath'), false)
  assert.deepEqual(r.logs, [])
})

test('social labels are social:<variant>/r<n>/b<k>; a variant runs its rounds in order, then its analyst', async () => {
  const r = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures() })
  const perVariant = (id) => [1, 2, 3].flatMap((n) => [0, 1, 2].map((k) => `social:${id}/r${n}/b${k}`))
  assert.deepEqual(labelsOf(r), [
    ...perVariant('alpha'),
    'analyst:alpha',
    ...perVariant('bravo'),
    'analyst:bravo',
    'report',
    'check',
  ])
})

test('exactly at the cap runs; one over returns {error} before any agent call', async () => {
  const atCap = await run(WORKFLOW, {
    args: makeArgs({ plan: planWith({ budget: { simulationAgentCalls: 18, cap: 18, dropped: [] } }) }),
    fixtures: makeFixtures(),
  })
  assert.ifError(atCap.error)
  assert.equal(atCap.result.coverage, '18 of 18 batch rounds completed')

  const over = await run(WORKFLOW, {
    args: makeArgs({ plan: planWith({ budget: { simulationAgentCalls: 18, cap: 17, dropped: [] } }) }),
    fixtures: makeFixtures(),
  })
  assert.ifError(over.error)
  assert.equal(over.result.error, '3 batches x 3 rounds x 2 variants = 18, which exceeds plan.budget.cap of 17')
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

test('a missing or invalid rounds value returns {error} before any agent call', async () => {
  for (const rounds of [undefined, null, 0, -1, 1.5, '3']) {
    const r = await run(WORKFLOW, { args: makeArgs({ plan: planWith({ rounds }) }), fixtures: makeFixtures() })
    assert.ifError(r.error)
    assert.equal(r.result.error, 'plan.rounds is missing or not a positive integer', String(rounds))
    assert.equal(r.calls.length, 0)
  }
})

test('personas are batched 4 at a time with the remainder last, and the batch count drives the cap', async () => {
  const five = personaRefs.slice(0, 5)
  const r = await run(WORKFLOW, { args: makeArgs({ personaRefs: five }), fixtures: makeFixtures() })
  assert.ifError(r.error)
  assert.equal(callsWithPrefix(r, 'social:').length, 2 * 3 * 2)
  assert.equal(r.result.coverage, '12 of 12 batch rounds completed')
  const first = promptOf(r, 'alpha', 1, 0)
  for (const p of five.slice(0, 4)) assert.ok(first.includes(`Feed for ${p.id}:`), p.id)
  assert.ok(!first.includes(`Feed for ${five[4].id}:`))
  const last = promptOf(r, 'alpha', 1, 1)
  assert.ok(last.includes(`Feed for ${five[4].id}:`))
  for (const p of five.slice(0, 4)) assert.ok(!last.includes(`Feed for ${p.id}:`), p.id)

  const eight = await run(WORKFLOW, { args: makeArgs({ personaRefs: personaRefs.slice(0, 8) }), fixtures: makeFixtures() })
  assert.equal(callsWithPrefix(eight, 'social:').length, 2 * 3 * 2)

  // 5 personas make 2 batches, so a cap of 11 is one call short; 9 personas would make 3 batches.
  const tight = await run(WORKFLOW, {
    args: makeArgs({ personaRefs: five, plan: planWith({ budget: { simulationAgentCalls: 12, cap: 11, dropped: [] } }) }),
    fixtures: makeFixtures(),
  })
  assert.equal(tight.result.error, '2 batches x 3 rounds x 2 variants = 12, which exceeds plan.budget.cap of 11')
  assert.equal(tight.calls.length, 0)
})

test('round 1 shows an empty feed to every persona, stated plainly', async () => {
  const r = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures() })
  for (const variantId of VARIANT_IDS) {
    for (const k of [0, 1, 2]) {
      const prompt = promptOf(r, variantId, 1, k)
      for (const persona of batchOf(k)) {
        assert.ok(prompt.includes(`Feed for ${persona.id}:\n${EMPTY_FEED}\n`), `${variantId}/b${k}/${persona.id}`)
        assert.deepEqual(feedOf(prompt, persona.id), [])
      }
    }
  }
})

test('a round-2 feed is ranked per persona: related author, reply count, id tie-break, top 10, posts and replies only', async () => {
  // Round 1 of the rich scenario (age 1 in round 2, so every item loses 1). Candidates are the
  // 15 posts and replies; likes (r1-b0-4, r1-b1-3) and ignores (r1-b0-6, r1-b2-1) never rank.
  // Replies received (a like counts): r1-b0-0 = 2, r1-b0-1 = 1, r1-b1-0 = 1, r1-b1-2 = 1.
  //
  // cohort-night-2, related to cohort-first-1 (authors of r1-b0-0 and r1-b0-9):
  //   r1-b0-0 = 2 + 2 - 1 = 3, r1-b0-9 = 2 + 0 - 1 = 1,
  //   r1-b0-1, r1-b1-0, r1-b1-2 = 0 + 1 - 1 = 0, everything else = -1.
  //   The -1 group sorts by id as strings: r1-b0-10 < r1-b0-11 < r1-b0-2 < r1-b0-3 < r1-b0-5 ...
  //   The cut at 10 keeps r1-b0-10, r1-b0-11, r1-b0-2, r1-b0-3, r1-b0-5 of it.
  //   Its own post r1-b1-0 stays in its feed.
  const nightTwo = [
    'r1-b0-0', 'r1-b0-9', 'r1-b0-1', 'r1-b1-0', 'r1-b1-2',
    'r1-b0-10', 'r1-b0-11', 'r1-b0-2', 'r1-b0-3', 'r1-b0-5',
  ]
  // cohort-night-3, related to nobody: r1-b0-0 = 2 - 1 = 1; r1-b0-1, r1-b1-0, r1-b1-2 = 0; else -1.
  const nightThree = [
    'r1-b0-0', 'r1-b0-1', 'r1-b1-0', 'r1-b1-2',
    'r1-b0-10', 'r1-b0-11', 'r1-b0-2', 'r1-b0-3', 'r1-b0-5', 'r1-b0-7',
  ]
  // cohort-share-1, related to cohort-night-1 (authors of r1-b0-2, r1-b0-8, r1-b0-11):
  //   r1-b0-0 = 1, r1-b0-2 = 1, r1-b0-8 = 1, r1-b0-11 = 1 (ties: r1-b0-0 < r1-b0-11 < r1-b0-2 < r1-b0-8),
  //   r1-b0-1, r1-b1-0, r1-b1-2 = 0, else -1 (r1-b0-10, r1-b0-3, r1-b0-5 make the cut).
  const shareOne = [
    'r1-b0-0', 'r1-b0-11', 'r1-b0-2', 'r1-b0-8',
    'r1-b0-1', 'r1-b1-0', 'r1-b1-2',
    'r1-b0-10', 'r1-b0-3', 'r1-b0-5',
  ]
  const notRanked = ['r1-b0-4', 'r1-b0-6', 'r1-b1-3', 'r1-b2-1']

  const r = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures({ scenario: scenarioRich }) })
  assert.ifError(r.error)
  for (const variantId of VARIANT_IDS) {
    const prompt = promptOf(r, variantId, 2, 1)
    assert.deepEqual(feedIds(prompt, 'cohort-night-2'), nightTwo, variantId)
    assert.deepEqual(feedIds(prompt, 'cohort-night-3'), nightThree, variantId)
    assert.deepEqual(feedIds(prompt, 'cohort-share-1'), shareOne, variantId)
    // cohort-share-2 has no related ids, so it sees what cohort-night-3 sees.
    assert.deepEqual(feedIds(prompt, 'cohort-share-2'), nightThree, variantId)

    const lastBatch = promptOf(r, variantId, 2, 2)
    // cohort-share-3 is related to cohort-first-1, like cohort-night-2.
    assert.deepEqual(feedIds(lastBatch, 'cohort-share-3'), nightTwo, variantId)

    for (const call of callsWithPrefix(r, `social:${variantId}/r2/`)) {
      for (const persona of batchOf(Number(call.opts.label.slice(-1)))) {
        const ids = feedIds(call.prompt, persona.id)
        assert.equal(ids.length, 10, `${call.opts.label}/${persona.id}: 15 candidates are cut to 10`)
        for (const id of notRanked) assert.ok(!ids.includes(id), `${persona.id} sees ${id}`)
      }
    }
  }
})

test('a feed item carries the post as it was kept, with its round and without its label', async () => {
  const r = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures({ scenario: scenarioRich }) })
  const feed = feedOf(promptOf(r, 'alpha', 2, 1), 'cohort-night-3')
  assert.deepEqual(feed[0], {
    id: 'r1-b0-0', personaId: 'cohort-first-1', type: 'post', targetId: '', text: 'alpha r1-b0-0', round: 1,
  })
  assert.deepEqual(feed.find((item) => item.id === 'r1-b0-3'), {
    id: 'r1-b0-3', personaId: 'cohort-first-3', type: 'reply', targetId: 'r1-b0-0', text: 'alpha r1-b0-3', round: 1,
  })
})

test('a round-3 feed weighs the age of a post: older posts lose, newer replies and likes count', async () => {
  // Round 1: r1-b0-0 (cohort-first-1), r1-b0-1 (cohort-first-2), r1-b1-0 (cohort-night-2), r1-b2-0 (cohort-share-3).
  // Round 2: r2-b0-0 post (cohort-first-1), r2-b0-1 reply to r1-b0-1, r2-b1-0 like of r1-b1-0,
  //          r2-b1-1 reply to r1-b0-1. Candidates: all but r2-b1-0. Replies received: r1-b0-1 = 2, r1-b1-0 = 1.
  // Round 3: round-1 items have age 2, round-2 items age 1.
  //
  // cohort-night-2, related to cohort-first-1:
  //   r2-b0-0 = 2 + 0 - 1 = 1; r1-b0-0 = 2 + 0 - 2 = 0; r1-b0-1 = 0 + 2 - 2 = 0;
  //   r1-b1-0 = 0 + 1 - 2 = -1; r2-b0-1 = r2-b1-1 = 0 + 0 - 1 = -1; r1-b2-0 = 0 + 0 - 2 = -2.
  //   Ties: r1-b0-0 < r1-b0-1; r1-b1-0 < r2-b0-1 < r2-b1-1.
  const nightTwo = ['r2-b0-0', 'r1-b0-0', 'r1-b0-1', 'r1-b1-0', 'r2-b0-1', 'r2-b1-1', 'r1-b2-0']
  // cohort-night-3, related to nobody:
  //   r1-b0-1 = 2 - 2 = 0; r1-b1-0 = r2-b0-0 = r2-b0-1 = r2-b1-1 = -1; r1-b0-0 = r1-b2-0 = -2.
  const nightThree = ['r1-b0-1', 'r1-b1-0', 'r2-b0-0', 'r2-b0-1', 'r2-b1-1', 'r1-b0-0', 'r1-b2-0']

  const r = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures({ scenario: scenarioThreads }) })
  assert.ifError(r.error)
  assert.deepEqual(r.logs, [])
  for (const variantId of VARIANT_IDS) {
    const prompt = promptOf(r, variantId, 3, 1)
    assert.deepEqual(feedIds(prompt, 'cohort-night-2'), nightTwo, variantId)
    assert.deepEqual(feedIds(prompt, 'cohort-night-3'), nightThree, variantId)
  }
})

test('a batch never sees the actions of its own round; a round sees every earlier round', async () => {
  const r = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures({ scenario: scenarioRich }) })
  for (const call of callsWithPrefix(r, 'social:')) {
    const [, round, k] = /\/r(\d+)\/b(\d+)$/.exec(call.opts.label).map(Number)
    for (const persona of batchOf(k)) {
      for (const item of feedOf(call.prompt, persona.id)) {
        assert.ok(item.round < round, `${call.opts.label}/${persona.id} sees ${item.id} from round ${item.round}`)
      }
    }
    if (round >= 2) {
      const own = call.opts.label.split('/')[0]
      assert.ok(!call.prompt.includes(`TEXT[${own}/r${round}/`), `${call.opts.label} sees its own round`)
    }
  }
  // Round 3 does see round 2.
  const roundThree = feedOf(promptOf(r, 'alpha', 3, 0), 'cohort-first-1')
  assert.ok(roundThree.some((item) => item.round === 2))
})

test('each variant keeps its own feed: a variant never sees another variant\'s posts', async () => {
  const r = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures({ scenario: scenarioRich }) })
  for (const variantId of VARIANT_IDS) {
    const others = VARIANT_IDS.filter((id) => id !== variantId)
    for (const call of callsWithPrefix(r, `social:${variantId}/`)) {
      for (const other of others) assert.ok(!call.prompt.includes(other), `${call.opts.label} mentions ${other}`)
    }
    for (const item of feedOf(promptOf(r, variantId, 2, 0), 'cohort-first-1')) {
      assert.ok(item.text.startsWith(`${variantId} `), item.text)
    }
  }
})

test('every social prompt contains exactly one variant\'s description and nothing from the other variants', async () => {
  const r = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures() })
  const socialCalls = callsWithPrefix(r, 'social:')
  assert.equal(socialCalls.length, 18)
  for (const call of socialCalls) {
    const variantId = call.opts.label.slice('social:'.length).split('/')[0]
    const own = plan.variants.find((v) => v.id === variantId)
    assert.equal(variantTextCount(call.prompt, DESCRIPTIONS), 1, call.opts.label)
    assert.ok(call.prompt.includes(own.description), call.opts.label)
    for (const other of plan.variants.filter((v) => v.id !== variantId)) {
      assert.ok(!call.prompt.toLowerCase().includes(other.id), `${call.opts.label} leaks id ${other.id}`)
      assert.ok(!call.prompt.includes(other.label), `${call.opts.label} leaks label ${other.label}`)
      assert.ok(!call.prompt.includes(other.description), `${call.opts.label} leaks description`)
    }
  }
})

test('a social prompt lists its batch\'s persona files and the facts file, and holds the ids to use, the round file path and the return shape', async () => {
  const r = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures() })
  for (const variant of plan.variants) {
    for (const round of [1, 2, 3]) {
      for (const k of [0, 1, 2]) {
        const prompt = promptOf(r, variant.id, round, k)
        const batch = batchOf(k)
        const where = `${variant.id}/r${round}/b${k}`
        for (const p of personaRefs) {
          assert.equal(prompt.includes(p.path), batch.includes(p), `${where}: ${p.id}`)
        }
        for (const p of batch) assert.ok(prompt.includes(`  - ${p.id}: ${p.path}\n`), `${where}: ${p.id} is listed with its path`)
        assert.ok(prompt.includes(FACTS_PATH), where)
        assert.match(prompt, /Read exactly these files and no other file/)
        assert.ok(prompt.includes(JSON.stringify({ id: variant.id, label: variant.label, description: variant.description }, null, 2)), where)
        assert.ok(prompt.includes(`This is round ${round} of 3, batch ${k}.`), where)
        assert.ok(prompt.includes(`${RUN_DIR}/sim/${variant.id}/round-${round}/b${k}.json`), where)
        assert.ok(prompt.includes(`"round": ${round}, "batch": ${k}`), where)

        const ids = Array.from({ length: batch.length * 4 }, (_, i) => `r${round}-b${k}-${i}`)
        assert.ok(prompt.includes(`in this order, without skipping any: ${ids.join(', ')}.`), where)
        assert.ok(!prompt.includes(`r${round}-b${k}-${ids.length},`) && !prompt.includes(`, r${round}-b${k}-${ids.length}`), where)
        assert.match(prompt, /Do not read the scenario file, plan\.json, or any other persona file/)
        assert.match(prompt, /\{actions: \[\.\.\.\]\}/)
        assert.match(prompt, /up to 4 actions this round/)
      }
    }
  }
  // The remainder batch holds 1 persona, so it gets 4 ids; the full batches get 16.
  assert.ok(promptOf(r, 'alpha', 1, 2).includes('r1-b2-0, r1-b2-1, r1-b2-2, r1-b2-3.'))
  assert.ok(promptOf(r, 'alpha', 1, 0).includes('r1-b0-14, r1-b0-15.'))
})

test('invalid actions are dropped and logged one by one; kept actions reach the state and the analyst', async () => {
  const r = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures({ scenario: scenarioInvalid }) })
  assert.ifError(r.error)
  assert.equal(r.result.coverage, '18 of 18 batch rounds completed')

  const b0 = 'social:alpha/r1/b0'
  assert.deepEqual(r.logs, [
    `dropped action 1 of ${b0}: id "r1-b0-5" is not the given id "r1-b0-1"`,
    `dropped action 2 of ${b0}: personaId "cohort-night-3" is not in this batch`,
    `dropped action 3 of ${b0}: reply targets "r1-b9-9", which is not an earlier action`,
    `dropped action 4 of ${b0}: type "shout" is not one of post, reply, like, ignore`,
    `dropped action 5 of ${b0}: post has targetId "r1-b0-0" but must have none`,
    `dropped action 7 of ${b0}: like targets "r1-b0-3", which is not an earlier action`,
    'dropped action 4 of social:alpha/r1/b2: id "r1-b2-4" has no given id to match: the batch allows only 4 actions',
  ])

  const analyst = callsLabeled(r, 'analyst:alpha')[0].prompt
  const actions = analystActions(analyst)
  assert.deepEqual(
    actions.slice(0, 10).map((a) => a.id),
    ['r1-b0-0', 'r1-b0-6', 'r1-b1-0', 'r1-b1-1', 'r1-b1-2', 'r1-b1-3', 'r1-b2-0', 'r1-b2-1', 'r1-b2-2', 'r1-b2-3'],
  )
  assert.equal(actions.length, 2 + 4 + 4 + 9 + 9)
  assert.deepEqual(actions[1], {
    round: 1, id: 'r1-b0-6', personaId: 'cohort-first-2', type: 'reply', targetId: 'r1-b0-0', text: 'KEPT-REPLY', label: 'Hypothesis',
  })
  for (const call of r.calls) assert.ok(!call.prompt.includes('DROP-'), `${call.opts.label} carries a dropped action`)

  // The kept actions feed round 2. cohort-first-1 is related to cohort-night-2, so r1-b1-0 = 2 + 0 - 1 = 1;
  // r1-b0-0 has one kept reply, so 0 + 1 - 1 = 0; r1-b0-6 = 0 + 0 - 1 = -1 and is first by id among the -1s.
  const roundTwo = feedOf(promptOf(r, 'alpha', 2, 0), 'cohort-first-1')
  assert.deepEqual(roundTwo.slice(0, 3).map((item) => item.id), ['r1-b1-0', 'r1-b0-0', 'r1-b0-6'])
  assert.equal(roundTwo[1].text, 'KEPT-POST')
  assert.equal(roundTwo[2].text, 'KEPT-REPLY')
})

test('an action may reply to an earlier kept action of its own batch, but not to another batch of the same round', async () => {
  const scenario = {
    'social:alpha/r1/b0': {
      actions: [
        { id: 'r1-b0-0', personaId: 'cohort-first-1', type: 'post', targetId: '', text: 'KEPT-ROOT', label: 'Hypothesis' },
        { id: 'r1-b0-1', personaId: 'cohort-first-2', type: 'reply', targetId: 'r1-b0-0', text: 'KEPT-SAME-BATCH', label: 'Hypothesis' },
        { id: 'r1-b0-2', personaId: 'cohort-first-3', type: 'like', targetId: 'r1-b0-3', text: 'DROP-LATER-ACTION', label: 'Hypothesis' },
      ],
    },
    'social:alpha/r1/b1': {
      actions: [
        { id: 'r1-b1-0', personaId: 'cohort-night-2', type: 'reply', targetId: 'r1-b0-0', text: 'DROP-OTHER-BATCH', label: 'Hypothesis' },
      ],
    },
  }
  const r = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures({ scenario }) })
  assert.ifError(r.error)
  assert.deepEqual(r.logs, [
    'dropped action 2 of social:alpha/r1/b0: like targets "r1-b0-3", which is not an earlier action',
    'dropped action 0 of social:alpha/r1/b1: reply targets "r1-b0-0", which is not an earlier action',
  ])
  const ids = analystActions(callsLabeled(r, 'analyst:alpha')[0].prompt).map((a) => a.id)
  assert.ok(ids.includes('r1-b0-1'))
  assert.ok(!ids.includes('r1-b1-0'))
  // In round 2 the same reply is fine: r1-b0-0 is then an earlier-round action.
  const later = {
    ...scenario,
    'social:alpha/r2/b1': {
      actions: [{ id: 'r2-b1-0', personaId: 'cohort-night-2', type: 'reply', targetId: 'r1-b0-0', text: 'KEPT-LATER-ROUND', label: 'Hypothesis' }],
    },
  }
  const r2 = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures({ scenario: later }) })
  assert.ok(analystActions(callsLabeled(r2, 'analyst:alpha')[0].prompt).some((a) => a.id === 'r2-b1-0'))
})

test('a null batch is logged, counted in coverage, and the variant carries on without it', async () => {
  const dead = 'social:bravo/r2/b1'
  const r = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures({ [dead]: null }) })
  assert.ifError(r.error)
  assert.equal(r.result.coverage, '17 of 18 batch rounds completed')
  assert.deepEqual(r.logs, [`social batch returned null: ${dead}`])
  assert.equal(callsWithPrefix(r, 'social:').length, 18)
  assert.equal(callsWithPrefix(r, 'social:bravo/r3/').length, 3)
  assert.equal(callsWithPrefix(r, 'analyst:').length, 2)

  const bravo = callsLabeled(r, 'analyst:bravo')[0].prompt
  assert.ok(!bravo.includes('TEXT[social:bravo/r2/b1#'))
  assert.ok(bravo.includes('TEXT[social:bravo/r2/b0#0]'))
  assert.ok(callsLabeled(r, 'analyst:alpha')[0].prompt.includes('TEXT[social:alpha/r2/b1#0]'))
  assert.ok(callsLabeled(r, 'report')[0].prompt.includes('Coverage: 17 of 18 batch rounds completed'))
})

test('a variant whose batches all failed gets no analyst and is called out to the report', async () => {
  const base = socialResponder()
  const r = await run(WORKFLOW, {
    args: makeArgs(),
    fixtures: makeFixtures({ 'social:': (prompt, opts) => (opts.label.startsWith('social:bravo/') ? null : base(prompt, opts)) }),
  })
  assert.ifError(r.error)
  assert.equal(r.result.coverage, '9 of 18 batch rounds completed')
  assert.equal(callsWithPrefix(r, 'analyst:').length, 1)
  assert.equal(callsLabeled(r, 'analyst:bravo').length, 0)
  assert.equal(r.logs.filter((line) => line.startsWith('social batch returned null')).length, 9)
  assert.ok(r.logs.some((line) => line.includes('no analysis for variant bravo') && line.includes('had no valid actions')))
  const reportPrompt = callsLabeled(r, 'report')[0].prompt
  assert.match(reportPrompt, /No analysis exists for variant\(s\): bravo/)
  assert.ok(reportPrompt.includes('"bravo": null'))
})

test('when no variant gets an analysis it returns {error} with coverage and writes no report', async () => {
  const r = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures({ 'social:': null }) })
  assert.ifError(r.error)
  assert.equal(
    r.result.error,
    'no analysis was produced for any variant (0 of 18 batch rounds completed)',
  )
  assert.equal(r.result.coverage, '0 of 18 batch rounds completed')
  assert.equal(callsLabeled(r, 'report').length, 0)
  assert.equal(callsWithPrefix(r, 'analyst:').length, 0)

  const noAnalysts = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures({ 'analyst:': null }) })
  assert.match(noAnalysts.result.error, /no analysis was produced for any variant \(18 of 18 batch rounds completed\)/)
  assert.equal(callsLabeled(noAnalysts, 'report').length, 0)
})

test('the analyst gets the variant\'s full action list, the persona to cohort map, and writes its analysis file', async () => {
  const r = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures() })
  const cohortIds = Object.fromEntries(personaRefs.map((p) => [p.id, p.cohortId]))
  for (const variant of plan.variants) {
    const prompt = callsLabeled(r, `analyst:${variant.id}`)[0].prompt
    const expected = [1, 2, 3].flatMap((round) =>
      [0, 1, 2].flatMap((k) =>
        defaultBatch(variant.id, round, k).actions.map((a) => ({ round, ...a })),
      ),
    )
    assert.deepEqual(analystActions(prompt), expected, variant.id)
    assert.ok(prompt.includes(JSON.stringify(cohortIds, null, 2)), variant.id)
    assert.ok(prompt.includes(`${RUN_DIR}/analysis/${variant.id}.json`), variant.id)
    assert.ok(prompt.includes(`${variant.id}/round-<n>/<actionId>`), variant.id)
    assert.ok(!prompt.includes('<personaId>:<step>'), variant.id)
    assert.ok(prompt.includes(variant.description), variant.id)
    for (const other of plan.variants.filter((v) => v.id !== variant.id)) {
      assert.ok(!prompt.includes(other.description), variant.id)
      assert.ok(!prompt.includes(`TEXT[social:${other.id}/`), variant.id)
    }
  }
})

test('the report prompt asks for social citations and counts batch rounds; the journey wording is gone', async () => {
  const r = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures({ 'social:bravo/r1/b0': null }) })
  const prompt = callsLabeled(r, 'report')[0].prompt
  assert.ok(prompt.includes('Coverage: 17 of 18 batch rounds completed'))
  assert.match(prompt, /citation in the format <variant>\/round-<n>\/<actionId>/)
  assert.ok(!prompt.includes('<personaId>:<step>'))
  assert.match(prompt, /If not every batch round completed, say that findings rest on the completed batch rounds only/)
  assert.ok(prompt.includes(NO_FILE))
  assert.ok(prompt.includes('Return the full report as `markdown`'))
  assert.ok(!prompt.includes('report.md') && !prompt.includes('report.final.md'), 'no report file is named')
  assert.ok(prompt.includes(JSON.stringify({ alpha: analysis, bravo: analysis }, null, 2)))
  for (const output of plan.expectedOutputs) assert.ok(prompt.includes(output), output)
})

test('a dirty check after a social run triggers revise and check-2, then revise-2 and check-3 when check-2 is dirty', async () => {
  const r = await runDirty({ 'check-3': check2Dirty })
  assert.ifError(r.error)
  assert.deepEqual(labelsOf(r).slice(-6), ['report', 'check', 'revise', 'check-2', 'revise-2', 'check-3'])
  assert.deepEqual(r.result, {
    coverage: '18 of 18 batch rounds completed',
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
  assert.equal(Object.hasOwn(r.result, 'reportPath'), false)
})

test('the check, revise and check-2 prompts carry the report text inline and tell the agent to write no file', async () => {
  const r = await runDirty()
  const names = ['report.md', 'report.final.md', 'check.json', 'check-2.json']

  const check = callsLabeled(r, 'check')[0].prompt
  assert.ok(check.includes(REPORT.markdown))
  assert.ok(check.includes(`You may read the simulation logs under ${RUN_DIR}/sim/ to verify citations`))
  assert.ok(check.includes(NO_FILE))
  assert.ok(check.includes('Return {violations, untraced}'))
  assert.ok(check.includes('<variant>/round-<n>/<actionId>'))
  for (const rule of plan.rules) assert.ok(check.includes(rule), rule)
  for (const name of names) assert.ok(!check.includes(name), `check names ${name}`)

  const revise = callsLabeled(r, 'revise')[0].prompt
  assert.ok(revise.includes(REPORT.markdown))
  assert.ok(revise.includes(checkDirty.violations[0].rule))
  assert.ok(revise.includes(checkDirty.violations[0].quote))
  assert.ok(revise.includes(checkDirty.violations[0].fix))
  assert.ok(revise.includes(checkDirty.untraced[0]))
  assert.ok(revise.includes(NO_FILE))
  assert.ok(revise.includes('Return the full revised report as `markdown`'))
  for (const name of names) assert.ok(!revise.includes(name), `revise names ${name}`)

  const check2 = callsLabeled(r, 'check-2')[0].prompt
  assert.ok(check2.includes(REVISED.markdown))
  assert.ok(!check2.includes(REPORT.markdown), 'check-2 sees the revised text only')
  assert.ok(check2.includes(NO_FILE))
  assert.ok(check2.includes('Return {violations, untraced}'))
  assert.ok(!check2.includes('Known issues'), 'the script, not the agent, appends Known issues')
  for (const rule of plan.rules) assert.ok(check2.includes(rule), rule)
  for (const name of names) assert.ok(!check2.includes(name), `check-2 names ${name}`)
})

test('Known issues are appended by the script exactly when the last check has items, as one bullet per violation and per untraced claim', async () => {
  const two = { violations: [{ rule: 'R1', quote: 'Q1', fix: 'F1' }], untraced: ['U1', 'U2'] }
  const dirty = await runDirty({ 'check-3': two })
  assert.equal(
    dirty.result.files['report.final.md'],
    `${REVISED_2.markdown.trimEnd()}\n\n## Known issues\n\n- R1: Q1 → F1\n- U1\n- U2\n`,
  )
  assert.deepEqual(dirty.result.files['check-3.json'], two)
  assert.deepEqual(dirty.result.finalCheck, two)

  const clean = await runDirty({ 'check-2': checkClean })
  assert.equal(clean.result.files['report.final.md'], REVISED.markdown)
  assert.deepEqual(clean.result.files['check-2.json'], checkClean)

  const noRevise = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures() })
  assert.equal(noRevise.result.files['report.final.md'], REPORT.markdown)
  assert.ok(!REPORT.markdown.includes('Known issues') && !REVISED.markdown.includes('Known issues'))
})

test('a null report, reviser or check, or one with no markdown text, returns {error} with coverage; a null check-2 also returns the last checked report', async () => {
  for (const report of [null, {}, { markdown: '' }, { markdown: '  ' }, { markdown: 42 }]) {
    const r = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures({ report }) })
    assert.ifError(r.error)
    assert.match(r.result.error, /report returned null or no markdown text/, JSON.stringify(report))
    assert.deepEqual(Object.keys(r.result), ['error', 'coverage'])
    assert.equal(r.result.coverage, '18 of 18 batch rounds completed')
    assert.equal(callsLabeled(r, 'check').length, 0)
  }
  for (const revise of [null, {}, { markdown: '' }, { markdown: 7 }]) {
    const r = await runDirty({ revise })
    assert.ifError(r.error)
    assert.match(r.result.error, /revise returned null or no markdown text/, JSON.stringify(revise))
    assert.deepEqual(Object.keys(r.result), ['error', 'coverage', 'files'])
    assert.equal(callsLabeled(r, 'check-2').length, 0)
  }

  const noCheck = await run(WORKFLOW, { args: makeArgs(), fixtures: makeFixtures({ check: null }) })
  assert.match(noCheck.result.error, /check returned null/)
  assert.deepEqual(Object.keys(noCheck.result), ['error', 'coverage'])
  assert.equal(callsLabeled(noCheck, 'revise').length, 0)

  const noCheck2 = await runDirty({ 'check-2': null })
  assert.match(noCheck2.result.error, /check-2 returned null/)
  assert.deepEqual(noCheck2.result, {
    error: noCheck2.result.error,
    coverage: '18 of 18 batch rounds completed',
    files: { 'report.md': REPORT.markdown, 'check.json': checkDirty, 'report.final.md': withKnownIssues(REPORT.markdown, checkDirty) },
  })
})

test('model per label: report, check and every revise and re-check are opus, analysts are opus, only social batches are sonnet, and every call has a label and a schema', async () => {
  const r = await runDirty()
  assert.ifError(r.error)
  assert.equal(r.calls.length, 18 + 2 + 6)
  const opus = ['report', 'check', 'revise', 'check-2', 'revise-2', 'check-3']
  for (const call of r.calls) {
    assert.equal(typeof call.opts.label, 'string')
    assert.ok(call.opts.label.length > 0)
    assert.equal(call.opts.model, call.opts.label.startsWith('social:') ? 'sonnet' : 'opus', call.opts.label)
    assert.ok(call.opts.schema, `${call.opts.label} has no schema`)
  }
  for (const label of opus) assert.equal(callsLabeled(r, label)[0].opts.model, 'opus', label)
  for (const call of callsWithPrefix(r, 'social:')) assert.equal(call.opts.model, 'sonnet', call.opts.label)
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

test('every schema has an object root and required is a subset of properties; the social schema lists the action fields and enums', async () => {
  const r = await runDirty()
  const seen = new Set()
  for (const call of r.calls) {
    assert.equal(call.opts.schema.type, 'object', call.opts.label)
    const family = call.opts.label.split(':')[0]
    if (seen.has(family)) continue
    seen.add(family)
    assertSchemaShape(call.opts.schema, family)
  }
  assert.deepEqual([...seen].sort(), ['analyst', 'check', 'check-2', 'check-3', 'report', 'revise', 'revise-2', 'social'])
  for (const label of ['report', 'revise']) {
    const markdownSchema = callsLabeled(r, label)[0].opts.schema
    assert.deepEqual(markdownSchema.required, ['markdown'], label)
    assert.deepEqual(Object.keys(markdownSchema.properties), ['markdown'], label)
  }

  const schema = socialCall(r, 'alpha', 1, 0).opts.schema
  assert.deepEqual(schema.required, ['actions'])
  const item = schema.properties.actions.items
  assert.deepEqual(item.required, ['id', 'personaId', 'type', 'targetId', 'text', 'label'])
  assert.deepEqual(item.properties.type.enum, ['post', 'reply', 'like', 'ignore'])
  assert.deepEqual(item.properties.label.enum, ['Fact', 'Hypothesis'])
})

test('meta phases cover every phase used; social calls run in Simulate and analysts in Analyze, passed explicitly', async () => {
  const r = await runDirty()
  const titles = r.meta.phases.map((p) => p.title)
  assert.deepEqual(titles, ['Simulate', 'Analyze', 'Report', 'Check'])
  for (const title of r.phases) assert.ok(titles.includes(title), `phase() title "${title}"`)
  for (const call of r.calls) assert.ok(titles.includes(call.phase), `${call.opts.label} phase "${call.phase}"`)
  assert.deepEqual([...new Set(r.calls.map((c) => c.phase))].sort(), [...titles].sort())

  for (const call of callsWithPrefix(r, 'social:')) assert.equal(call.opts.phase, 'Simulate', call.opts.label)
  for (const call of callsWithPrefix(r, 'analyst:')) assert.equal(call.opts.phase, 'Analyze', call.opts.label)
})

test('a trailing slash on runDir does not leak into social paths', async () => {
  const r = await run(WORKFLOW, { args: makeArgs({ runDir: `${RUN_DIR}/` }), fixtures: makeFixtures() })
  assert.ifError(r.error)
  for (const call of r.calls) assert.ok(!call.prompt.includes('//sim') && !call.prompt.includes('//analysis'), call.opts.label)
  assert.ok(promptOf(r, 'alpha', 1, 0).includes(`${RUN_DIR}/sim/alpha/round-1/b0.json`))
})

test('a social plan with missing or malformed personaRefs or factsPath returns {error} without calling any agent', async () => {
  const cases = [
    [{ personaRefs: undefined }, /args\.personaRefs must be an array of \{id, cohortId, path\}/],
    [{ personaRefs: [{ id: 'a', cohortId: 'c' }] }, /args\.personaRefs/],
    [{ factsPath: undefined }, /args\.factsPath must be a string/],
    [{ factsPath: null }, /args\.factsPath must be a string/],
  ]
  for (const [overrides, pattern] of cases) {
    const r = await run(WORKFLOW, { args: makeArgs(overrides), fixtures: makeFixtures() })
    assert.ifError(r.error)
    assert.match(r.result.error, pattern, JSON.stringify(overrides))
    assert.deepEqual(Object.keys(r.result), ['error'])
    assert.equal(r.calls.length, 0)
  }
})

test('refs without relatedIds are accepted, since relatedIds is optional', async () => {
  const bare = personaRefs.map(({ id, cohortId, path }) => ({ id, cohortId, path }))
  const r = await run(WORKFLOW, { args: makeArgs({ personaRefs: bare }), fixtures: makeFixtures() })
  assert.ifError(r.error)
  assert.equal(r.result.coverage, '18 of 18 batch rounds completed')
  assert.equal(r.calls.length, 22)
})
