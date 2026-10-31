import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from './harness.js'
import { personaName } from '../scripts/swarm-args.mjs'

const SCRIPT = fileURLToPath(new URL('../.claude/workflows/swarm-prepare.js', import.meta.url))
const readFixture = (name) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/prepare/${name}`, import.meta.url)), 'utf8'))

const extract = readFixture('extract.json')
const ontology = readFixture('ontology.json')
const plan = readFixture('plan.json')

const PACK_DIR = '/packs/example-app'
const RUN_DIR = '/packs/example-app/runs/2026-10-31-lead-message'
const REFS = '/repo/.claude/skills/swarm-sim/references'
const FILES = Object.keys(extract).map((name) => `${PACK_DIR}/${name}`)
const ARGS = { packDir: PACK_DIR, runDir: RUN_DIR, files: FILES, referencesDir: REFS }

const ACTOR_IDS = plan.cohorts.filter((c) => c.role === 'actor').map((c) => c.id)
const CONTEXT_IDS = plan.cohorts.filter((c) => c.role === 'context').map((c) => c.id)

function makePersona(cohortId, n) {
  return {
    id: `${cohortId}-${n}`,
    cohortId,
    name: personaName(cohortId, n),
    profile: `Profile ${n} of ${cohortId}.`,
    goals: ['A goal.'],
    constraints: ['A constraint.'],
    slant: `Slant ${n} of ${cohortId}`,
    evidenceRefs: ['05_evidence.md:4'],
    relatedIds: [],
  }
}

const personasFor = (cohortId, count = 3) => ({
  personas: Array.from({ length: count }, (_, i) => makePersona(cohortId, i + 1)),
})

/** Fixtures for a clean lead-message-shaped run; `overrides` replace entries by label. */
function fixtures(overrides = {}) {
  return {
    ...Object.fromEntries(Object.entries(extract).map(([name, result]) => [`extract:${name}`, result])),
    merge: ontology,
    plan,
    'personas:': (_prompt, opts) => personasFor(opts.label.slice('personas:'.length)),
    ...overrides,
  }
}

const prepare = ({ args = ARGS, overrides } = {}) => run(SCRIPT, { args, fixtures: fixtures(overrides) })
const labels = (r) => r.calls.map((c) => c.opts.label)
const callsWith = (r, prefix) => r.calls.filter((c) => c.opts.label.startsWith(prefix))
const promptFor = (r, label) => r.calls.find((c) => c.opts.label === label).prompt

test('a clean run makes 5 extract, 1 merge, 1 plan and 4 persona calls, none for context cohorts', async () => {
  const r = await prepare()
  assert.ifError(r.error)
  assert.equal(callsWith(r, 'extract:').length, 5)
  assert.equal(callsWith(r, 'merge').length, 1)
  assert.equal(callsWith(r, 'plan').length, 1)
  assert.equal(callsWith(r, 'personas:').length, 4)
  assert.equal(r.calls.length, 11)
  assert.deepEqual(callsWith(r, 'personas:').map((c) => c.opts.label), ACTOR_IDS.map((id) => `personas:${id}`))
  for (const id of CONTEXT_IDS) assert.ok(!labels(r).includes(`personas:${id}`), `persona call for context cohort ${id}`)
  assert.deepEqual(r.logs, [])
})

test('persona agents run only for cohorts with role actor and personaCount above 0', async () => {
  const cohorts = plan.cohorts.map((c) => {
    if (c.id === 'Partner_Representative') return { ...c, personaCount: 2 }
    if (c.id === 'Parent_Planner_Representative') return { ...c, personaCount: 0 }
    return c
  })
  const r = await prepare({ overrides: { plan: { ...plan, cohorts } } })
  assert.ifError(r.error)
  assert.deepEqual(
    callsWith(r, 'personas:').map((c) => c.opts.label),
    ['Parent_FirstLog_Representative', 'Parent_Returning_Representative', 'Parent_Sharing_Representative'].map(
      (id) => `personas:${id}`,
    ),
  )
})

test('a clean run returns the summary', async () => {
  const r = await prepare()
  assert.ifError(r.error)
  assert.equal(r.result.mode, 'journey')
  assert.deepEqual(r.result.variants, plan.variants)
  assert.deepEqual(r.result.cohorts, plan.cohorts)
  assert.equal(r.result.personas.length, 12)
  assert.deepEqual(r.result.personas[0], {
    id: 'Parent_FirstLog_Representative-1',
    name: 'Parent First Log 1',
    slant: 'Slant 1 of Parent_FirstLog_Representative',
  })
  assert.equal(r.result.plannedSimulationCalls, 36)
  assert.deepEqual(r.result.dropped, [])
  assert.deepEqual(r.result.problems, { nullExtractors: 0, droppedPersonas: 0, nullPersonaAgents: 0 })
  assert.equal(r.result.error, undefined)
})

test('the summary passes plan.budget.dropped through', async () => {
  const dropped = ['Cut personaCount of Parent_FirstLog_Representative from 4 to 3 to stay under 60 calls.']
  const r = await prepare({ overrides: { plan: { ...plan, budget: { simulationAgentCalls: 36, cap: 60, dropped } } } })
  assert.ifError(r.error)
  assert.deepEqual(r.result.dropped, dropped)
})

test('meta.phases titles equal the phase() titles called', async () => {
  const r = await prepare()
  assert.ifError(r.error)
  assert.deepEqual(r.meta.phases.map((p) => p.title), ['Extract', 'Merge', 'Plan', 'Personas'])
  assert.deepEqual(r.meta.phases.map((p) => p.title), r.phases)
  assert.equal(r.meta.name, 'swarm-prepare')
  assert.equal(r.meta.name, basename(SCRIPT, '.js'))
})

test('every call sets a label and a model: opus for every prepare call', async () => {
  const r = await prepare()
  assert.ifError(r.error)
  for (const call of r.calls) {
    assert.equal(typeof call.opts.label, 'string')
    assert.ok(call.opts.label.length > 0, 'a call has an empty label')
    assert.equal(call.opts.model, 'opus', `model of ${call.opts.label}`)
  }
})

test('every call passes a schema whose objects have required keys that exist in properties', async () => {
  const r = await prepare()
  assert.ifError(r.error)
  const walk = (node, where) => {
    if (node.type === 'object') {
      assert.equal(typeof node.properties, 'object', `${where}: properties`)
      assert.ok(Array.isArray(node.required), `${where}: required`)
      for (const key of node.required) assert.ok(key in node.properties, `${where}: required key ${key} not in properties`)
      for (const [key, child] of Object.entries(node.properties)) walk(child, `${where}.${key}`)
    } else if (node.type === 'array') {
      walk(node.items, `${where}[]`)
    }
  }
  for (const call of r.calls) {
    assert.equal(call.opts.schema?.type, 'object', `${call.opts.label}: root type`)
    walk(call.opts.schema, call.opts.label)
  }
  const planSchema = r.calls.find((c) => c.opts.label === 'plan').opts.schema
  assert.deepEqual(planSchema.required, [])
  for (const key of ['error', 'mode', 'variants', 'cohorts', 'timeline', 'rounds', 'rules', 'expectedOutputs', 'budget']) {
    assert.ok(key in planSchema.properties, `plan schema lacks ${key}`)
  }
  assert.deepEqual(planSchema.properties.error, { type: 'string' })
})

test('a plan {error} stops the workflow after the plan call', async () => {
  const r = await prepare({ overrides: { plan: { error: 'The pack has no scenario file.' } } })
  assert.ifError(r.error)
  assert.deepEqual(r.result, { error: 'The pack has no scenario file.' })
  assert.equal(callsWith(r, 'personas:').length, 0)
  assert.equal(labels(r).at(-1), 'plan')
  assert.equal(r.calls.length, 7)
  assert.ok(!r.phases.includes('Personas'))
  assert.ok(r.logs.some((l) => l.includes('The pack has no scenario file.')))
})

test('a null plan stops the workflow with an error', async () => {
  const r = await prepare({ overrides: { plan: null } })
  assert.ifError(r.error)
  assert.match(r.result.error, /plan agent returned null/)
  assert.equal(callsWith(r, 'personas:').length, 0)
  assert.equal(r.calls.length, 7)
})

test('an incomplete plan stops the workflow with an error naming the problem', async () => {
  const { timeline, ...noTimeline } = plan
  const r = await prepare({ overrides: { plan: noTimeline } })
  assert.ifError(r.error)
  assert.match(r.result.error, /invalid plan: timeline is missing/)
  assert.equal(callsWith(r, 'personas:').length, 0)

  const empty = await prepare({ overrides: { plan: {} } })
  assert.match(empty.result.error, /mode is not journey or social/)
})

test('a persona with a bad id is dropped and logged', async () => {
  const cohortId = 'Parent_FirstLog_Representative'
  const bad = [
    makePersona(cohortId, 1),
    makePersona(cohortId, 2),
    { ...makePersona(cohortId, 3), id: 'FirstLog-3' },
    { ...makePersona(cohortId, 4), id: `${cohortId}-4` },
    { ...makePersona(cohortId, 5), id: `${cohortId}-0` },
    { ...makePersona(cohortId, 6), id: `${cohortId}-03` },
    { ...makePersona(cohortId, 3), cohortId: 'Parent_Other_Representative' },
    makePersona(cohortId, 1),
  ]
  const r = await prepare({ overrides: { [`personas:${cohortId}`]: { personas: bad } } })
  assert.ifError(r.error)
  const ids = r.result.personas.map((p) => p.id)
  assert.deepEqual(ids.filter((id) => id.startsWith(cohortId)), [`${cohortId}-1`, `${cohortId}-2`])
  assert.equal(ids.length, 2 + 9)
  assert.equal(r.result.problems.droppedPersonas, 6)
  for (const id of ['FirstLog-3', `${cohortId}-4`, `${cohortId}-0`, `${cohortId}-03`]) {
    assert.ok(r.logs.some((l) => l.includes(`dropped persona "${id}"`)), `no drop log for ${id}`)
  }
  assert.ok(r.logs.some((l) => l.includes('cohortId')), 'no drop log for the cohortId mismatch')
  assert.ok(r.logs.some((l) => l.includes('duplicate')), 'no drop log for the duplicate id')
  assert.ok(r.logs.some((l) => l.includes(`personas:${cohortId}: kept 2 of 3`)))
})

test('a null persona agent is logged and counted, and the other cohorts keep their personas', async () => {
  const cohortId = 'Parent_Sharing_Representative'
  const r = await prepare({ overrides: { [`personas:${cohortId}`]: null } })
  assert.ifError(r.error)
  assert.equal(r.result.problems.nullPersonaAgents, 1)
  assert.equal(r.result.personas.length, 9)
  assert.ok(r.logs.some((l) => l.includes(`personas:${cohortId}`) && l.includes('null')))
})

test('a null extractor is logged and the merge still runs with the remaining 4 results', async () => {
  const r = await prepare({ overrides: { 'extract:03_cohorts.md': null } })
  assert.ifError(r.error)
  assert.equal(r.result.problems.nullExtractors, 1)
  assert.ok(r.logs.some((l) => l.includes('extract:03_cohorts.md') && l.includes('null')))
  assert.equal(callsWith(r, 'merge').length, 1)
  const merge = promptFor(r, 'merge')
  for (const name of Object.keys(extract).filter((n) => n !== '03_cohorts.md')) {
    assert.ok(merge.includes(`"file":"${name}"`), `merge prompt lacks ${name}`)
  }
  assert.ok(!merge.includes('"file":"03_cohorts.md"'))
  assert.equal((merge.match(/"file":/g) ?? []).length, 4)
  assert.equal(callsWith(r, 'plan').length, 1)
})

test('when every extractor returns null the workflow stops before merge', async () => {
  const allNull = Object.fromEntries(Object.keys(extract).map((name) => [`extract:${name}`, null]))
  const r = await prepare({ overrides: allNull })
  assert.ifError(r.error)
  assert.match(r.result.error, /No extractor returned a result/)
  assert.equal(r.result.personas, undefined)
  assert.equal(r.calls.length, 5)
  assert.equal(r.logs.length, 5)
})

test('a null merge stops the workflow before the plan', async () => {
  const r = await prepare({ overrides: { merge: null } })
  assert.ifError(r.error)
  assert.match(r.result.error, /merge agent returned null/)
  assert.equal(callsWith(r, 'plan').length, 0)
  assert.equal(r.calls.length, 6)
})

test('missing args return an error before any agent call', async () => {
  for (const args of [{}, { ...ARGS, runDir: undefined }, { ...ARGS, referencesDir: undefined }, { ...ARGS, files: undefined }]) {
    const r = await prepare({ args })
    assert.ifError(r.error)
    assert.match(r.result.error, /needs args\.runDir, args\.referencesDir and args\.files/)
    assert.equal(r.calls.length, 0)
  }
})

test('prompts name the file each agent writes', async () => {
  const r = await prepare()
  assert.ifError(r.error)
  for (const name of Object.keys(extract)) {
    const prompt = promptFor(r, `extract:${name}`)
    assert.ok(prompt.includes(`${PACK_DIR}/${name}`), `extract prompt lacks the path of ${name}`)
    assert.ok(prompt.includes('Write no file'))
    assert.ok(prompt.includes(`"${name}:<line>"`))
  }
  assert.ok(promptFor(r, 'merge').includes(`${RUN_DIR}/ontology.json`))
  assert.ok(promptFor(r, 'plan').includes(`${RUN_DIR}/plan.json`))
  for (const id of ACTOR_IDS) {
    const prompt = promptFor(r, `personas:${id}`)
    assert.ok(prompt.includes(`${RUN_DIR}/personas/<id>.json`))
    assert.ok(prompt.includes('Return {"personas": [...]} through the schema'))
  }
})

test('the plan prompt has the scenario path, the ontology, the references and the rules', async () => {
  const r = await prepare()
  assert.ifError(r.error)
  const prompt = promptFor(r, 'plan')
  assert.ok(prompt.includes(`${PACK_DIR}/02_scenario.md`))
  assert.ok(prompt.includes(JSON.stringify(ontology)))
  assert.ok(prompt.includes(`${REFS}/rules.md`))
  assert.ok(prompt.includes(`${REFS}/formats.md`))
  assert.match(prompt, /Pick "social" only when the scenario defines a shared feed/)
  assert.match(prompt, /role is "actor" when the cohort walks the timeline/)
  assert.match(prompt, /role is "context" when the cohort only appears inside actors' steps/)
  assert.match(prompt, /personaCount 0/)
  assert.ok(prompt.includes('cap is 60'))
  assert.ok(prompt.includes('Journey: personas × variants'))
  assert.ok(prompt.includes('Social: ceil(personas / 4) × rounds × variants'))
})

test('the plan prompt says so when no pack file is a scenario', async () => {
  const files = FILES.filter((f) => !f.includes('scenario'))
  const r = await prepare({ args: { ...ARGS, files }, overrides: { 'extract:02_scenario.md': null } })
  assert.ifError(r.error)
  const prompt = promptFor(r, 'plan')
  assert.ok(prompt.includes('No scenario file was found'))
  assert.ok(!prompt.includes('Scenario file, read it in full'))
})

test('a persona prompt has all cohorts, the cohort relations, its entity, its claims and its paths', async () => {
  const r = await prepare()
  assert.ifError(r.error)
  const id = 'Parent_FirstLog_Representative'
  const prompt = promptFor(r, `personas:${id}`)
  assert.ok(prompt.includes(JSON.stringify(plan.cohorts)))
  assert.ok(prompt.includes(`${id}-1, ${id}-2, ${id}-3`))
  assert.ok(prompt.includes(`${REFS}/personas.md`))
  assert.ok(prompt.includes(`${REFS}/formats.md`))
  assert.ok(prompt.includes(`${RUN_DIR}/personas/`))

  const entity = ontology.entities.find((e) => e.id === id)
  assert.ok(prompt.includes(JSON.stringify(entity)))

  const byType = (type) => ontology.relations.find((rel) => rel.type === type)
  for (const type of ['invites', 'hands_over_to', 'shares_schedule_with']) {
    assert.ok(prompt.includes(JSON.stringify(byType(type))), `relation ${type} between cohorts is missing`)
  }
  assert.ok(!prompt.includes('may_use'), 'a relation to a non-cohort entity is inlined')

  assert.ok(prompt.includes('Parent_FirstLog_Representative tends to doubt that free tracking stays free.'))
  assert.ok(!prompt.includes('Parent_Sharing_Representative wants every family member'))
  assert.ok(!prompt.includes('App_Product is free to download.'))
  assert.ok(!prompt.includes('No claim names'))
})

test('a persona prompt falls back to all claims when none names the cohort', async () => {
  const noPlannerClaims = {
    ...ontology,
    claims: ontology.claims.filter((c) => !c.text.includes('Parent_Planner_Representative')),
  }
  const r = await prepare({ overrides: { merge: noPlannerClaims } })
  assert.ifError(r.error)
  const planner = promptFor(r, 'personas:Parent_Planner_Representative')
  assert.ok(planner.includes('No claim names'))
  assert.ok(planner.includes('Parent_FirstLog_Representative tends to doubt'))
  assert.ok(!promptFor(r, 'personas:Parent_FirstLog_Representative').includes('No claim names'))
})

test('the script source avoids banned APIs and starts with the meta literal', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  for (const banned of ['Date.now', 'Math.random', 'new Date()', 'import ', 'require(']) {
    assert.ok(!source.includes(banned), `source contains ${banned}`)
  }
  assert.ok(source.startsWith('export const meta = {'))
})


test('the persona prompt gives each persona its role-label name', async () => {
  const r = await prepare()
  const prompt = promptFor(r, 'personas:Parent_FirstLog_Representative')
  assert.match(prompt, /Parent_FirstLog_Representative-2 is "Parent First Log 2"/)
  assert.match(prompt, /Never use a personal first name or surname/)
})

test('a persona with a personal name instead of its role label is dropped', async () => {
  const r = await prepare({ overrides: {
    'personas:Parent_FirstLog_Representative': {
      personas: [1, 2, 3].map((n) => ({ ...makePersona('Parent_FirstLog_Representative', n), ...(n === 2 ? { name: 'Jordan' } : {}) })),
    },
  } })
  assert.ok(r.logs.some((l) => /dropped persona "Parent_FirstLog_Representative-2" because its name is "Jordan"/.test(l)))
  assert.equal(r.result.problems.droppedPersonas, 1)
})
