import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  interviewArgs,
  personaName,
  prepareArgs,
  REFERENCES_DIR,
  ANALYSIS_DIR,
  REPO_ROOT,
  runArgs,
  saveArgs,
} from '../scripts/swarm-args.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/swarm-args.mjs', import.meta.url))
const DATE = '2026-10-31'

// A fresh temp folder that is removed when the test ends.
function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'swarm-args-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function write(path, content) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
}

function makePack(root, names = ['scenario.md', 'overview.md']) {
  const packDir = join(root, 'pack')
  mkdirSync(packDir)
  for (const name of names) write(join(packDir, name), `# ${name}\n`)
  return packDir
}

const persona = (cohortId, n) => ({
  id: `${cohortId}-${n}`,
  cohortId,
  name: personaName(cohortId, n),
  profile: 'A synthetic representative.',
  goals: ['A goal.'],
  constraints: ['A constraint.'],
  slant: `Slant ${n}`,
  evidenceRefs: ['scenario.md:1'],
  relatedIds: [],
})

const PLAN = {
  mode: 'journey',
  variants: [{ id: 'A', label: 'Message A', description: 'Text A' }],
  cohorts: [
    { id: 'zeta', entityId: 'zeta', role: 'actor', personaCount: 2, reason: 'r' },
    { id: 'partner', entityId: 'partner', role: 'context', personaCount: 0, reason: 'r' },
    { id: 'alpha', entityId: 'alpha', role: 'actor', personaCount: 1, reason: 'r' },
  ],
  timeline: [{ step: 1, label: 'See', description: 'd' }],
  rules: ['r'],
  expectedOutputs: ['o'],
  budget: { simulationAgentCalls: 3, cap: 60, dropped: [] },
}

const ONTOLOGY = {
  entityTypes: [],
  entities: [],
  relations: [],
  claims: [
    { text: 'A fact.', status: 'Fact', source: 'scenario.md:1' },
    { text: 'An assumption.', status: 'Assumption', source: 'scenario.md:2' },
    { text: 'A hypothesis.', status: 'Hypothesis', source: 'scenario.md:3' },
    { text: 'An unknown.', status: 'Unknown', source: 'scenario.md:4' },
    { text: 'Another fact.', status: 'Fact', source: 'overview.md:7' },
  ],
}

// Writes a prepared run folder at <root>/pack/runs/<name> and returns its path.
function makeRun(root, { plan = PLAN, ontology = ONTOLOGY, personas, name = '2026-10-31-x' } = {}) {
  const runDir = join(root, 'pack', 'runs', name)
  mkdirSync(join(runDir, 'personas'), { recursive: true })
  if (plan !== null) write(join(runDir, 'plan.json'), plan)
  if (ontology !== null) write(join(runDir, 'ontology.json'), ontology)
  const list = personas ?? [persona('zeta', 1), persona('zeta', 2), persona('alpha', 1)]
  for (const p of list) write(join(runDir, 'personas', `${p.id}.json`), p)
  return runDir
}

// ---------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------

test('prepare creates the run folder, lists top-level .md files and never lists runs/', (t) => {
  const root = tempRoot(t)
  const packDir = makePack(root, ['scenario.md', '01_overview.md'])
  write(join(packDir, 'notes.txt'), 'not markdown')
  write(join(packDir, '.hidden.md'), 'hidden')
  write(join(packDir, 'sub', 'nested.md'), 'nested')
  write(join(packDir, 'folder.md', 'inside.md'), 'a folder whose name ends in .md')
  write(join(packDir, 'runs', 'old-run', 'report.md'), 'an earlier run')

  const out = prepareArgs(packDir, 'lead-message', { date: DATE })

  assert.deepEqual(Object.keys(out), ['packDir', 'runDir', 'files', 'referencesDir'])
  assert.equal(out.packDir, packDir)
  assert.equal(out.runDir, join(packDir, 'runs', `${DATE}-lead-message`))
  assert.deepEqual(out.files, [join(packDir, '01_overview.md'), join(packDir, 'scenario.md')])
  assert.equal(out.referencesDir, REFERENCES_DIR)
  assert.equal(out.referencesDir, join(REPO_ROOT, '.claude', 'skills', 'swarm-sim', 'references'))
  assert.ok(existsSync(join(out.referencesDir, 'formats.md')), 'referencesDir points at the real references')
  for (const sub of ['personas', 'sim', 'analysis']) assert.ok(existsSync(join(out.runDir, sub)), `${sub}/ exists`)
})

test('prepare adds -2 and -3 when the run folder exists and leaves the old folder alone', (t) => {
  const root = tempRoot(t)
  const packDir = makePack(root)

  const first = prepareArgs(packDir, 'lead-message', { date: DATE })
  write(join(first.runDir, 'plan.json'), '{"keep":"me"}')
  const second = prepareArgs(packDir, 'lead-message', { date: DATE })
  const third = prepareArgs(packDir, 'lead-message', { date: DATE })

  assert.equal(first.runDir, join(packDir, 'runs', `${DATE}-lead-message`))
  assert.equal(second.runDir, join(packDir, 'runs', `${DATE}-lead-message-2`))
  assert.equal(third.runDir, join(packDir, 'runs', `${DATE}-lead-message-3`))
  assert.equal(readFileSync(join(first.runDir, 'plan.json'), 'utf8'), '{"keep":"me"}')
  assert.ok(existsSync(join(third.runDir, 'personas')))
  assert.deepEqual(second.files, first.files, 'earlier runs are never listed as pack files')
})

test('prepare defaults the date to today in local time', (t) => {
  const root = tempRoot(t)
  const packDir = makePack(root)
  const local = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((n) => String(n).padStart(2, '0')).join('-')

  const before = local(new Date())
  const out = prepareArgs(packDir, 'slug')
  const after = local(new Date())

  const name = out.runDir.split('/').pop()
  assert.ok(name === `${before}-slug` || name === `${after}-slug`, `unexpected run folder name: ${name}`)
})

test('prepare fails when the only .md files are under runs/ or a subfolder, and creates nothing', (t) => {
  const root = tempRoot(t)
  const packDir = join(root, 'pack')
  write(join(packDir, 'runs', 'old-run', 'report.md'), 'an earlier run')
  write(join(packDir, 'sub', 'nested.md'), 'nested')
  write(join(packDir, 'notes.txt'), 'text')

  assert.throws(() => prepareArgs(packDir, 'x', { date: DATE }), /no top-level \.md file/)
  assert.deepEqual(existsSync(join(packDir, 'runs', `${DATE}-x`)), false)
})

test('prepare fails on an empty pack without creating runs/', (t) => {
  const root = tempRoot(t)
  const packDir = join(root, 'pack')
  mkdirSync(packDir)

  assert.throws(() => prepareArgs(packDir, 'x', { date: DATE }), /no top-level \.md file/)
  assert.equal(existsSync(join(packDir, 'runs')), false)
})

test('prepare rejects a missing packDir, a bad slug and a bad date', (t) => {
  const root = tempRoot(t)
  const packDir = makePack(root)

  assert.throws(() => prepareArgs(join(root, 'nope'), 'x', { date: DATE }), /packDir does not exist/)
  assert.throws(() => prepareArgs(join(packDir, 'scenario.md'), 'x', { date: DATE }), /packDir does not exist/)
  for (const slug of ['', '../escape', 'a/b', '.hidden', undefined]) {
    assert.throws(() => prepareArgs(packDir, slug, { date: DATE }), /slug must be/, `slug ${JSON.stringify(slug)}`)
  }
  for (const date of ['2026-13-01', '2026-02-30', '31-10-2026', 'today']) {
    assert.throws(() => prepareArgs(packDir, 'x', { date }), /date must be/, `date ${date}`)
  }
  assert.equal(existsSync(join(packDir, 'runs')), false, 'a failed prepare creates no folder')
})

test('prepare expands a leading ~ to the home folder', (t) => {
  const root = tempRoot(t)
  const packDir = makePack(root)
  const home = process.env.HOME
  process.env.HOME = root
  t.after(() => {
    process.env.HOME = home
  })

  const out = prepareArgs('~/pack', 'x', { date: DATE })

  assert.equal(out.packDir, packDir)
})

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

test('run returns the plan, a reference to each expected persona in plan order, the facts path and the paths', (t) => {
  const root = tempRoot(t)
  const runDir = makeRun(root)
  // Written in a different order than the plan on purpose; context cohort "partner" has no files.

  const out = runArgs(runDir)

  assert.deepEqual(Object.keys(out), ['packDir', 'runDir', 'plan', 'personaRefs', 'factsPath', 'referencesDir'])
  assert.equal(out.packDir, join(root, 'pack'))
  assert.equal(out.runDir, runDir)
  assert.deepEqual(out.plan, PLAN)
  assert.deepEqual(
    out.personaRefs.map((ref) => ref.id),
    ['zeta-1', 'zeta-2', 'alpha-1'],
  )
  assert.deepEqual(out.personaRefs[2], {
    id: 'alpha-1',
    cohortId: 'alpha',
    path: join(runDir, 'personas', 'alpha-1.json'),
    relatedIds: [],
  })
  for (const ref of out.personaRefs) {
    assert.ok(isAbsolute(ref.path), `${ref.id} path is absolute`)
    assert.deepEqual(JSON.parse(readFileSync(ref.path, 'utf8')).id, ref.id, `${ref.id} path points at its file`)
  }
  assert.equal(out.factsPath, join(runDir, 'facts.json'))
  assert.ok(isAbsolute(out.factsPath))
  assert.equal(out.referencesDir, REFERENCES_DIR)
})

test('run passes each persona\'s relatedIds on its reference, and an empty list when the file has none', (t) => {
  const root = tempRoot(t)
  const { relatedIds: _dropped, ...bare } = persona('alpha', 1)
  const runDir = makeRun(root, {
    personas: [{ ...persona('zeta', 1), relatedIds: ['alpha-1'] }, persona('zeta', 2), bare],
  })

  const { personaRefs } = runArgs(runDir)

  assert.deepEqual(
    personaRefs.map((ref) => ref.relatedIds),
    [['alpha-1'], [], []],
  )
})

test('run holds no persona content in its output: only ids, cohort ids, paths and related ids', (t) => {
  const root = tempRoot(t)
  const runDir = makeRun(root)

  const out = runArgs(runDir)

  for (const ref of out.personaRefs) assert.deepEqual(Object.keys(ref), ['id', 'cohortId', 'path', 'relatedIds'])
  const text = JSON.stringify(out)
  for (const secret of ['A synthetic representative.', 'A goal.', 'A constraint.', 'Slant 1']) {
    assert.ok(!text.includes(secret), `output leaks "${secret}"`)
  }
  assert.ok(!text.includes('An assumption.') && !text.includes('A fact.'), 'output holds no claim text')
})

test('run accepts a trailing slash and a plan with no actor cohorts', (t) => {
  const root = tempRoot(t)
  const plan = { ...PLAN, cohorts: [PLAN.cohorts[1]] }
  const runDir = makeRun(root, { plan, personas: [] })
  rmSync(join(runDir, 'personas'), { recursive: true })

  const out = runArgs(`${runDir}/`)

  assert.equal(out.runDir, runDir)
  assert.deepEqual(out.personaRefs, [])
})

test('run writes facts.json with only the claims with status Fact, as {text, source}', (t) => {
  const root = tempRoot(t)
  const ontology = {
    ...ONTOLOGY,
    claims: [...ONTOLOGY.claims, { text: 'Lowercase status.', status: 'fact', source: 'x.md:1', extra: 'dropped' }],
  }
  const runDir = makeRun(root, { ontology })

  const { factsPath } = runArgs(runDir)

  assert.equal(factsPath, join(runDir, 'facts.json'))
  assert.deepEqual(JSON.parse(readFileSync(factsPath, 'utf8')), [
    { text: 'A fact.', source: 'scenario.md:1' },
    { text: 'Another fact.', source: 'overview.md:7' },
  ])
})

test('run overwrites a stale facts.json, so repeating it for a resume is safe', (t) => {
  const root = tempRoot(t)
  const runDir = makeRun(root)
  write(join(runDir, 'facts.json'), [{ text: 'Stale.', source: 'old.md:1' }])

  const first = runArgs(runDir)
  const written = readFileSync(first.factsPath, 'utf8')
  const second = runArgs(runDir)

  assert.ok(!written.includes('Stale.'))
  assert.equal(readFileSync(second.factsPath, 'utf8'), written)
})

test('run writes an empty facts.json when the ontology has no Fact claims', (t) => {
  const root = tempRoot(t)
  const runDir = makeRun(root, { ontology: { claims: [{ text: 'An unknown.', status: 'Unknown', source: 's:1' }] } })

  const { factsPath } = runArgs(runDir)

  assert.deepEqual(JSON.parse(readFileSync(factsPath, 'utf8')), [])
})

test('run writes no facts.json when a check fails', (t) => {
  const root = tempRoot(t)
  const runDir = makeRun(root, { personas: [persona('zeta', 1)] })

  assert.throws(() => runArgs(runDir), /missing: zeta-2\.json, alpha-1\.json/)
  assert.equal(existsSync(join(runDir, 'facts.json')), false)
})

test('run names a missing persona file', (t) => {
  const root = tempRoot(t)
  const runDir = makeRun(root, { personas: [persona('zeta', 1), persona('alpha', 1)] })

  assert.throws(
    () => runArgs(runDir),
    (e) => /missing: zeta-2\.json/.test(e.message) && !/extra:/.test(e.message),
  )
})

test('run names every missing file when personas/ is absent', (t) => {
  const root = tempRoot(t)
  const runDir = makeRun(root, { personas: [] })
  rmSync(join(runDir, 'personas'), { recursive: true })

  assert.throws(() => runArgs(runDir), /missing: zeta-1\.json, zeta-2\.json, alpha-1\.json/)
})

test('run names an extra persona file, even one for a context cohort or a higher n', (t) => {
  const root = tempRoot(t)
  const runDir = makeRun(root)
  write(join(runDir, 'personas', 'zeta-3.json'), persona('zeta', 3))
  write(join(runDir, 'personas', 'partner-1.json'), persona('partner', 1))
  write(join(runDir, 'personas', 'notes.txt'), 'stray')

  assert.throws(
    () => runArgs(runDir),
    (e) =>
      /extra: notes\.txt, partner-1\.json, zeta-3\.json/.test(e.message) && !/missing:/.test(e.message),
  )
})

test('run reports missing and extra files together and ignores .DS_Store', (t) => {
  const root = tempRoot(t)
  const runDir = makeRun(root, { personas: [persona('zeta', 1), persona('alpha', 1)] })
  write(join(runDir, 'personas', 'stale-1.json'), persona('stale', 1))
  write(join(runDir, 'personas', '.DS_Store'), 'finder')

  assert.throws(
    () => runArgs(runDir),
    (e) => /missing: zeta-2\.json/.test(e.message) && /extra: stale-1\.json/.test(e.message) && !/DS_Store/.test(e.message),
  )
})

test('run names a persona file that is not valid JSON or whose id does not match its name', (t) => {
  const root = tempRoot(t)
  const runDir = makeRun(root)
  write(join(runDir, 'personas', 'zeta-1.json'), '{ not json')
  write(join(runDir, 'personas', 'zeta-2.json'), persona('zeta', 1))

  assert.throws(
    () => runArgs(runDir),
    (e) => /unreadable: zeta-1\.json is not valid JSON/.test(e.message) && /does not match its name: zeta-2\.json/.test(e.message),
  )
})

test('run fails and names plan.json when it is missing, and ontology.json when it is missing', (t) => {
  const root = tempRoot(t)
  const noPlan = makeRun(root, { plan: null, name: 'no-plan' })
  const noOntology = makeRun(root, { ontology: null, name: 'no-ontology' })
  const neither = makeRun(root, { plan: null, ontology: null, name: 'neither' })

  assert.throws(() => runArgs(noPlan), (e) => /plan\.json is missing/.test(e.message) && !/ontology/.test(e.message))
  assert.throws(() => runArgs(noOntology), (e) => /ontology\.json is missing/.test(e.message) && !/plan\.json/.test(e.message))
  assert.throws(() => runArgs(neither), /plan\.json is missing; ontology\.json is missing/)
})

test('run fails when plan.json or ontology.json is not valid JSON or lacks its list', (t) => {
  const root = tempRoot(t)
  const badPlan = makeRun(root, { plan: '{ nope', name: 'bad-plan' })
  const noCohorts = makeRun(root, { plan: { mode: 'journey' }, name: 'no-cohorts' })
  const noClaims = makeRun(root, { ontology: { entities: [] }, name: 'no-claims' })

  assert.throws(() => runArgs(badPlan), /plan\.json is not valid JSON/)
  assert.throws(() => runArgs(noCohorts), /plan\.json has no cohorts list/)
  assert.throws(() => runArgs(noClaims), /ontology\.json has no claims list/)
})

test('run rejects a fractional personaCount, a missing runDir and a folder outside runs/', (t) => {
  const root = tempRoot(t)
  const fractional = makeRun(root, {
    plan: { ...PLAN, cohorts: [{ ...PLAN.cohorts[0], personaCount: 1.5 }] },
    name: 'fractional',
  })
  const outside = join(root, 'elsewhere')
  mkdirSync(outside)

  assert.throws(() => runArgs(fractional), /whole-number personaCount/)
  assert.throws(() => runArgs(join(root, 'nope')), /runDir does not exist/)
  assert.throws(() => runArgs(outside), /runDir must be <packDir>\/runs\//)
})

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

const CHECK = { violations: [{ rule: 'r', quote: 'q', fix: 'f' }], untraced: ['A claim.'] }

// Writes a swarm-run result as JSON at <root>/run-result.json and returns its path.
function writeResult(root, result) {
  const path = join(root, 'run-result.json')
  write(path, result)
  return path
}

test('save writes each file into the run folder: strings as-is, objects as pretty JSON with a trailing newline', (t) => {
  const root = tempRoot(t)
  const runDir = makeRun(root)
  const resultPath = writeResult(root, {
    coverage: '1 of 1 pairs completed',
    files: {
      'report.md': '# Report\n\nA claim. [A/zeta-1:1]',
      'check.json': CHECK,
      'report.final.md': '# Report\r\n\r\nNo trailing newline',
      'check-2.json': { violations: [], untraced: [] },
    },
    finalCheck: { violations: [], untraced: [] },
  })

  const out = saveArgs(runDir, resultPath)

  assert.deepEqual(out, {
    written: ['report.md', 'check.json', 'report.final.md', 'check-2.json'],
    reportFinalPath: join(runDir, 'report.final.md'),
  })
  assert.equal(readFileSync(join(runDir, 'report.md'), 'utf8'), '# Report\n\nA claim. [A/zeta-1:1]')
  assert.equal(readFileSync(join(runDir, 'check.json'), 'utf8'), `${JSON.stringify(CHECK, null, 2)}\n`)
  assert.equal(readFileSync(join(runDir, 'report.final.md'), 'utf8'), '# Report\r\n\r\nNo trailing newline')
  assert.equal(readFileSync(join(runDir, 'check-2.json'), 'utf8'), `${JSON.stringify({ violations: [], untraced: [] }, null, 2)}\n`)
})

test('save writes only the files given, overwrites older ones and leaves the rest of the run folder alone', (t) => {
  const root = tempRoot(t)
  const runDir = makeRun(root)
  write(join(runDir, 'report.md'), 'old report')
  write(join(runDir, 'check-2.json'), 'stale')
  const resultPath = writeResult(root, { files: { 'report.md': 'new report', 'report.final.md': 'new report' } })

  const out = saveArgs(runDir, resultPath)

  assert.deepEqual(out.written, ['report.md', 'report.final.md'])
  assert.equal(readFileSync(join(runDir, 'report.md'), 'utf8'), 'new report')
  assert.equal(readFileSync(join(runDir, 'check-2.json'), 'utf8'), 'stale')
  assert.equal(existsSync(join(runDir, 'check.json')), false)
  assert.ok(existsSync(join(runDir, 'plan.json')))
})

test('save gives a null reportFinalPath when report.final.md is not among the files', (t) => {
  const root = tempRoot(t)
  const runDir = makeRun(root)

  const out = saveArgs(runDir, writeResult(root, { files: { 'report.md': 'text' } }))

  assert.deepEqual(out, { written: ['report.md'], reportFinalPath: null })
})

test('save accepts a trailing slash on runDir', (t) => {
  const root = tempRoot(t)
  const runDir = makeRun(root)

  const out = saveArgs(`${runDir}/`, writeResult(root, { files: { 'report.final.md': 'text' } }))

  assert.equal(out.reportFinalPath, join(runDir, 'report.final.md'))
})

test('save rejects a file name outside the allow-list and writes nothing, even for the allowed entries', (t) => {
  const root = tempRoot(t)
  const runDir = makeRun(root)
  const names = ['plan.json', 'facts.json', '../escape.md', 'sim/x.md', '/abs/report.md', 'report.md.bak', '__proto__', '']

  for (const name of names) {
    const resultPath = writeResult(root, { files: { 'report.md': 'text', [name]: 'bad' } })
    assert.throws(() => saveArgs(runDir, resultPath), /not allowed: /, JSON.stringify(name))
    assert.equal(existsSync(join(runDir, 'report.md')), false, `nothing written for ${JSON.stringify(name)}`)
  }
  assert.deepEqual(JSON.parse(readFileSync(join(runDir, 'plan.json'), 'utf8')), PLAN)
  assert.equal(existsSync(join(root, 'pack', 'runs', 'escape.md')), false)
})

test('save rejects content that is not text or JSON, and a result with no files object', (t) => {
  const root = tempRoot(t)
  const runDir = makeRun(root)

  for (const content of [null, 7, true]) {
    const resultPath = writeResult(root, { files: { 'report.md': 'text', 'check.json': content } })
    assert.throws(() => saveArgs(runDir, resultPath), /file content must be text or JSON.*check\.json/)
    assert.equal(existsSync(join(runDir, 'report.md')), false)
  }
  for (const result of [{ error: 'boom', coverage: 'c' }, { files: null }, { files: ['report.md'] }, { files: 'report.md' }, null, []]) {
    assert.throws(() => saveArgs(runDir, writeResult(root, result)), /result has no files object/, JSON.stringify(result))
  }
})

test('save fails on a missing or invalid result file, a missing runDir, a folder outside runs/ and a run without plan.json', (t) => {
  const root = tempRoot(t)
  const runDir = makeRun(root)
  const resultPath = writeResult(root, { files: { 'report.md': 'text' } })
  const outside = join(root, 'elsewhere')
  mkdirSync(outside)
  const noPlan = makeRun(root, { plan: null, name: 'no-plan' })
  write(join(root, 'bad.json'), '{not json')

  assert.throws(() => saveArgs(runDir, join(root, 'nope.json')), /nope\.json is missing/)
  assert.throws(() => saveArgs(runDir, join(root, 'bad.json')), /bad\.json is not valid JSON/)
  assert.throws(() => saveArgs(runDir, undefined), /resultJsonPath is required/)
  assert.throws(() => saveArgs(undefined, resultPath), /runDir is required/)
  assert.throws(() => saveArgs(join(root, 'nope'), resultPath), /runDir does not exist/)
  assert.throws(() => saveArgs(outside, resultPath), /runDir must be <packDir>\/runs\//)
  assert.throws(() => saveArgs(noPlan, resultPath), /plan\.json is missing/)
  assert.equal(existsSync(join(noPlan, 'report.md')), false)
})

// ---------------------------------------------------------------------------
// interview
// ---------------------------------------------------------------------------

const journeyLine = (variant, step, extra = {}) => ({
  step,
  variant,
  sees: `sees ${step}`,
  decision: 'install',
  reason: `reason ${step}`,
  quote: `quote ${step}`,
  label: 'Hypothesis',
  ...extra,
})

test('interview returns the persona and its journey lines from every variant, tagged', (t) => {
  const root = tempRoot(t)
  const runDir = makeRun(root)
  const sim = (...parts) => join(runDir, 'sim', ...parts)
  const jsonl = (lines) => `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`
  write(sim('B', 'zeta-1.jsonl'), jsonl([journeyLine('B', 1), journeyLine('B', 2)]))
  write(sim('A', 'zeta-1.jsonl'), jsonl([journeyLine('A', 1), journeyLine('A', 2)]))
  write(sim('A', 'zeta-2.jsonl'), jsonl([journeyLine('A', 1, { quote: 'someone else' })]))
  write(sim('baseline', 'alpha-1.jsonl'), jsonl([journeyLine('baseline', 1)]))

  const out = interviewArgs(runDir, 'zeta-1')

  assert.deepEqual(out.persona, persona('zeta', 1))
  assert.deepEqual(
    out.logs.map((l) => [l.kind, l.variant, l.citation, l.quote]),
    [
      ['journey', 'A', 'A/zeta-1:1', 'quote 1'],
      ['journey', 'A', 'A/zeta-1:2', 'quote 2'],
      ['journey', 'B', 'B/zeta-1:1', 'quote 1'],
      ['journey', 'B', 'B/zeta-1:2', 'quote 2'],
    ],
  )
  assert.equal(out.logs[0].decision, 'install')
  assert.equal(out.logs[0].label, 'Hypothesis')
})

test('interview returns only this persona\'s social actions, ordered by round then batch', (t) => {
  const root = tempRoot(t)
  const runDir = makeRun(root)
  const action = (id, personaId, type = 'post') => ({ id, personaId, type, targetId: '', text: `text ${id}`, label: 'Hypothesis' })
  const roundFile = (variant, round, batch, actions) =>
    write(join(runDir, 'sim', variant, `round-${round}`, `${batch}.json`), { round, batch, actions })
  roundFile('C', 10, 1, [action('r10-b1-0', 'zeta-1')])
  roundFile('C', 2, 2, [action('r2-b2-0', 'zeta-2'), action('r2-b2-1', 'zeta-1', 'like')])
  roundFile('C', 2, 1, [action('r2-b1-0', 'zeta-1'), action('r2-b1-1', 'alpha-1')])
  roundFile('C', 1, 1, [action('r1-b1-0', 'alpha-1')])
  write(join(runDir, 'sim', 'C', 'round-2', 'notes.txt'), 'ignored')
  write(join(runDir, 'sim', 'C', 'round-x', '1.json'), 'ignored')

  const { logs } = interviewArgs(runDir, 'zeta-1')

  assert.deepEqual(
    logs.map((l) => [l.kind, l.variant, l.round, l.citation, l.type]),
    [
      ['social', 'C', 2, 'C/round-2/r2-b1-0', 'post'],
      ['social', 'C', 2, 'C/round-2/r2-b2-1', 'like'],
      ['social', 'C', 10, 'C/round-10/r10-b1-0', 'post'],
    ],
  )
})

test('interview combines journey and social logs and returns an empty list when nothing was simulated', (t) => {
  const root = tempRoot(t)
  const runDir = makeRun(root)

  assert.deepEqual(interviewArgs(runDir, 'alpha-1').logs, [])

  write(join(runDir, 'sim', 'A', 'alpha-1.jsonl'), `${JSON.stringify(journeyLine('A', 1))}\n\n`)
  write(join(runDir, 'sim', 'A', 'round-1', '1.json'), {
    round: 1,
    batch: 1,
    actions: [{ id: 'r1-b1-0', personaId: 'alpha-1', type: 'ignore', targetId: '', text: '', label: 'Hypothesis' }],
  })
  assert.deepEqual(
    interviewArgs(runDir, 'alpha-1').logs.map((l) => l.citation),
    ['A/alpha-1:1', 'A/round-1/r1-b1-0'],
  )
})

test('interview fails when the persona file is missing or the id is a path', (t) => {
  const root = tempRoot(t)
  const runDir = makeRun(root)
  write(join(root, 'pack', 'runs', 'secret.json'), { id: 'secret' })

  assert.throws(() => interviewArgs(runDir, 'nobody-1'), /persona file not found: .*nobody-1\.json/)
  assert.throws(() => interviewArgs(runDir, '../secret'), /personaId must be a persona id/)
  assert.throws(() => interviewArgs(runDir, ''), /personaId must be a persona id/)
  assert.throws(() => interviewArgs(join(root, 'nope'), 'zeta-1'), /runDir does not exist/)
})

test('interview fails and names the file when a log line or round file is corrupt', (t) => {
  const root = tempRoot(t)
  const runDir = makeRun(root)
  write(join(runDir, 'sim', 'A', 'zeta-1.jsonl'), `${JSON.stringify(journeyLine('A', 1))}\n{ broken\n`)

  assert.throws(() => interviewArgs(runDir, 'zeta-1'), /A\/zeta-1\.jsonl line 2 is not valid JSON/)

  rmSync(join(runDir, 'sim'), { recursive: true })
  write(join(runDir, 'sim', 'B', 'round-1', '1.json'), { round: 1, batch: 1 })
  assert.throws(() => interviewArgs(runDir, 'zeta-1'), /B\/round-1\/1\.json has no actions list/)
})

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// Runs the script from an unrelated folder, so only the script's own location can supply <repoRoot>.
function cli(root, ...args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8' })
  const lines = result.stdout.split('\n').filter(Boolean)
  assert.equal(lines.length, 1, `expected one line of JSON on stdout, got: ${result.stdout}`)
  return { status: result.status, out: JSON.parse(lines[0]), stderr: result.stderr }
}

test('cli prepare prints the args as one line of JSON and exits 0', (t) => {
  const root = tempRoot(t)
  const packDir = makePack(root)

  const { status, out, stderr } = cli(root, 'prepare', packDir, 'lead-message', '--date', DATE)

  assert.equal(status, 0, stderr)
  assert.equal(out.runDir, join(packDir, 'runs', `${DATE}-lead-message`))
  assert.deepEqual(out.files, [join(packDir, 'overview.md'), join(packDir, 'scenario.md')])
  assert.equal(out.referencesDir, join(REPO_ROOT, '.claude', 'skills', 'swarm-sim', 'references'))
})

test('cli run and interview print JSON and exit 0', (t) => {
  const root = tempRoot(t)
  const runDir = makeRun(root)
  write(join(runDir, 'sim', 'A', 'zeta-1.jsonl'), `${JSON.stringify(journeyLine('A', 1))}\n`)

  const run = cli(root, 'run', runDir)
  const interview = cli(root, 'interview', runDir, 'zeta-1')

  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.out.personaRefs.length, 3)
  assert.equal(run.out.factsPath, join(runDir, 'facts.json'))
  assert.equal(interview.status, 0, interview.stderr)
  assert.equal(interview.out.persona.id, 'zeta-1')
  assert.equal(interview.out.logs[0].citation, 'A/zeta-1:1')
})

test('cli save writes the files and prints {written, reportFinalPath}', (t) => {
  const root = tempRoot(t)
  const runDir = makeRun(root)
  const resultPath = writeResult(root, { coverage: 'c', files: { 'report.md': 'text', 'check.json': CHECK, 'report.final.md': 'text' } })

  const { status, out, stderr } = cli(root, 'save', runDir, resultPath)

  assert.equal(status, 0, stderr)
  assert.deepEqual(out, { written: ['report.md', 'check.json', 'report.final.md'], reportFinalPath: join(runDir, 'report.final.md') })
  assert.equal(readFileSync(join(runDir, 'report.final.md'), 'utf8'), 'text')
  assert.deepEqual(JSON.parse(readFileSync(join(runDir, 'check.json'), 'utf8')), CHECK)
})

test('cli run writes facts.json with only the Fact claims and prints no personas or facts key', (t) => {
  const root = tempRoot(t)
  const runDir = makeRun(root)

  const { status, out, stderr } = cli(root, 'run', runDir)

  assert.equal(status, 0, stderr)
  assert.deepEqual(Object.keys(out), ['packDir', 'runDir', 'plan', 'personaRefs', 'factsPath', 'referencesDir'])
  assert.equal(Object.hasOwn(out, 'personas'), false)
  assert.equal(Object.hasOwn(out, 'facts'), false)
  assert.equal(out.factsPath, join(runDir, 'facts.json'))
  assert.deepEqual(JSON.parse(readFileSync(out.factsPath, 'utf8')), [
    { text: 'A fact.', source: 'scenario.md:1' },
    { text: 'Another fact.', source: 'overview.md:7' },
  ])
  assert.deepEqual(
    out.personaRefs.map(({ id, cohortId, path }) => ({ id, cohortId, path })),
    [
      { id: 'zeta-1', cohortId: 'zeta', path: join(runDir, 'personas', 'zeta-1.json') },
      { id: 'zeta-2', cohortId: 'zeta', path: join(runDir, 'personas', 'zeta-2.json') },
      { id: 'alpha-1', cohortId: 'alpha', path: join(runDir, 'personas', 'alpha-1.json') },
    ],
  )
})

test('cli failures print {"error": ...} on stdout and exit 1', (t) => {
  const root = tempRoot(t)
  const runDir = makeRun(root, { personas: [persona('zeta', 1)] })

  const cases = [
    [['prepare', join(root, 'nope'), 'x'], /packDir does not exist/],
    [['prepare', join(root, 'pack')], /usage: .*prepare <packDir> <slug>/],
    [['prepare', join(root, 'pack'), 'x', '--bogus'], /bogus/],
    [['run', runDir], /missing: zeta-2\.json, alpha-1\.json/],
    [['run'], /usage: .*run <runDir>/],
    [['save', runDir], /usage: .*save <runDir> <resultJsonPath>/],
    [['save', runDir, writeResult(root, { files: { 'plan.json': 'x' } })], /not allowed: plan\.json/],
    [['interview', runDir, 'nobody-1'], /persona file not found/],
    [['interview', runDir], /usage: .*interview <runDir> <personaId>/],
    [['frobnicate'], /usage:/],
    [[], /usage:/],
  ]
  for (const [args, pattern] of cases) {
    const { status, out } = cli(root, ...args)
    assert.equal(status, 1, `exit code for ${args.join(' ')}`)
    assert.deepEqual(Object.keys(out), ['error'])
    assert.match(out.error, pattern, `error for ${args.join(' ')}`)
  }
})


test('personaName turns a cohort id into a role label', () => {
  assert.equal(personaName('Parent_StoreShopper_Representative', 3), 'Parent Store Shopper 3')
  assert.equal(personaName('Grandparent_Caregiver_Representative', 1), 'Grandparent Caregiver 1')
})

test('run fails when a persona file carries a personal name instead of its role label', (t) => {
  const runDir = makeRun(tempRoot(t))
  const file = join(runDir, 'personas', 'zeta-1.json')
  const persona = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...persona, name: 'Jordan' }))
  assert.throws(() => runArgs(runDir), /name is not the role label: zeta-1\.json \(name must be "zeta 1"\)/)
})

test('save accepts check-3.json and, when the result has check.json, removes later checks the result does not include', (t) => {
  const root = tempRoot(t)
  const runDir = makeRun(root)
  write(join(runDir, 'check-2.json'), 'stale')
  write(join(runDir, 'check-3.json'), 'stale')
  const clean = { violations: [], untraced: [] }

  const out = saveArgs(runDir, writeResult(root, { files: { 'report.md': 'r', 'check.json': CHECK, 'report.final.md': 'r', 'check-2.json': clean } }))

  assert.deepEqual(out.written, ['report.md', 'check.json', 'report.final.md', 'check-2.json'])
  assert.equal(readFileSync(join(runDir, 'check-2.json'), 'utf8'), `${JSON.stringify(clean, null, 2)}\n`)
  assert.equal(existsSync(join(runDir, 'check-3.json')), false)

  saveArgs(runDir, writeResult(root, { files: { 'check.json': CHECK, 'check-3.json': clean } }))
  assert.equal(existsSync(join(runDir, 'check-2.json')), false)
  assert.ok(existsSync(join(runDir, 'check-3.json')))
})

test('run clears the report, check and result files of an earlier run, and keeps sim/ and analysis/', (t) => {
  const root = tempRoot(t)
  const runDir = makeRun(root)
  const old = ['report.md', 'report.final.md', 'check.json', 'check-2.json', 'check-3.json', 'run-result.json']
  for (const name of old) write(join(runDir, name), 'old')
  write(join(runDir, 'sim', 'A', 'p-1.jsonl'), '{}')
  write(join(runDir, 'analysis', 'A.json'), '{}')

  runArgs(runDir)

  for (const name of old) assert.equal(existsSync(join(runDir, name)), false, name)
  assert.ok(existsSync(join(runDir, 'sim', 'A', 'p-1.jsonl')))
  assert.ok(existsSync(join(runDir, 'analysis', 'A.json')))
})

test('prepare, run and save refuse a pack or run folder inside the swarm-sim repo', (t) => {
  assert.throws(() => prepareArgs(REPO_ROOT, 'demo', { date: DATE }), /inside the swarm-sim repo/)
  const inside = join(REPO_ROOT, 'runs', '2026-10-31-inside-test')
  const runsExisted = existsSync(join(REPO_ROOT, 'runs'))
  mkdirSync(inside, { recursive: true })
  t.after(() => {
    rmSync(inside, { recursive: true, force: true })
    if (!runsExisted) rmSync(join(REPO_ROOT, 'runs'), { recursive: true, force: true })
  })
  assert.throws(() => runArgs(inside), /inside the swarm-sim repo/)
  assert.throws(() => saveArgs(inside, 'x.json'), /inside the swarm-sim repo/)
})

test('prepare and run accept a pack under the git-ignored analysis folder, but not the folder itself or a look-alike', (t) => {
  assert.equal(ANALYSIS_DIR, join(REPO_ROOT, 'analysis'))
  const analysisExisted = existsSync(ANALYSIS_DIR)
  const app = join(ANALYSIS_DIR, '__guard-test-app')
  const lookalike = join(REPO_ROOT, 'analysis-guard-test')
  t.after(() => {
    rmSync(app, { recursive: true, force: true })
    rmSync(lookalike, { recursive: true, force: true })
    if (!analysisExisted) rmSync(ANALYSIS_DIR, { recursive: true, force: true })
  })
  const packDir = join(app, '01_pack')
  mkdirSync(packDir, { recursive: true })
  writeFileSync(join(packDir, '01_scenario.md'), '# Scenario\n')
  const out = prepareArgs(packDir, 'demo', { date: DATE })
  assert.equal(out.runDir, join(packDir, 'runs', `${DATE}-demo`))
  assert.throws(() => prepareArgs(ANALYSIS_DIR, 'demo', { date: DATE }), /inside the swarm-sim repo/)
  mkdirSync(lookalike, { recursive: true })
  writeFileSync(join(lookalike, '01_scenario.md'), '# Scenario\n')
  assert.throws(() => prepareArgs(lookalike, 'demo', { date: DATE }), /inside the swarm-sim repo/)
})
