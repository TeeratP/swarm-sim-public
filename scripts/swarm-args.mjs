// swarm-args: the deterministic file work behind the swarm-sim skill. It builds run folders,
// lists pack files, checks persona files and extracts facts, so the skill never has to guess.
// No dependencies. <repoRoot> is resolved from this script's own location.
//
// Usage (every command prints one line of JSON; on failure it prints {"error": "..."} and exits 1):
//   node scripts/swarm-args.mjs prepare <packDir> <slug> [--date YYYY-MM-DD]
//     -> {packDir, runDir, files, referencesDir}   args for the swarm-prepare workflow
//   node scripts/swarm-args.mjs run <runDir>
//     -> {packDir, runDir, plan, personaRefs, factsPath, referencesDir}   args for the swarm-run workflow.
//        Writes <runDir>/facts.json. personaRefs is [{id, cohortId, path, relatedIds}] and factsPath is
//        absolute, so the agents read personas and facts from disk instead of the loop copying them into args.
//   node scripts/swarm-args.mjs save <runDir> <resultJsonPath>
//     -> {written, reportFinalPath}   writes the report files from the swarm-run workflow's return value.
//        <resultJsonPath> holds that return value as JSON. Each entry of its `files` is written into <runDir>:
//        a string as-is, an object as pretty JSON. Only report.md, check.json, report.final.md, check-2.json
//        and check-3.json are allowed. When `files` has check.json, a check-2.json or check-3.json it lacks is
//        removed, so a stale later check never stands in for the new one.
//        `written` lists the file names; reportFinalPath is null when report.final.md was not among them.
//   node scripts/swarm-args.mjs interview <runDir> <personaId>
//     -> {persona, logs}   what the skill needs to answer in a persona's voice
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const SCRIPT_PATH = fileURLToPath(import.meta.url)

/** Absolute path of the swarm-sim repo that holds this script. */
export const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..')

/** Absolute path of the agent reference files, passed to the workflows as `referencesDir`. */
// Git-ignored home for packs and runs inside the repo.
export const ANALYSIS_DIR = join(REPO_ROOT, 'analysis')
export const REFERENCES_DIR = join(REPO_ROOT, '.claude', 'skills', 'swarm-sim', 'references')

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const SUBFOLDERS = ['personas', 'sim', 'analysis']
// Finder writes this into any folder a user opens; it is never a persona.
const IGNORED_PERSONA_ENTRIES = new Set(['.DS_Store'])
const collator = new Intl.Collator('en', { numeric: true })

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function absolutePath(path) {
  if (path === '~' || path.startsWith('~/')) return join(homedir(), path.slice(1))
  return resolve(path)
}

const statOf = (path) => statSync(path, { throwIfNoEntry: false })
const isDirectory = (path) => statOf(path)?.isDirectory() ?? false
const isFile = (path) => statOf(path)?.isFile() ?? false

// Sorted names in `dir` for which keep(fullPath, name) is true. A missing folder has no names.
function listNames(dir, keep) {
  if (!isDirectory(dir)) return []
  return readdirSync(dir)
    .filter((name) => keep(join(dir, name), name))
    .sort(collator.compare)
}

// Reads a JSON file. Throws an error that names `label` when the file is missing or not valid JSON.
function readJson(path, label = path) {
  if (!isFile(path)) throw new Error(`${label} is missing`)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(`${label} is not valid JSON (${e.message})`)
  }
}

// Runs fn(). On a throw, records the message in `problems` and returns undefined.
function attempt(fn, problems) {
  try {
    return fn()
  } catch (e) {
    problems.push(e.message)
    return undefined
  }
}

function existingRunDir(runDirInput) {
  if (!runDirInput) throw new Error('runDir is required')
  const runDir = absolutePath(runDirInput)
  if (!isDirectory(runDir)) throw new Error(`runDir does not exist or is not a folder: ${runDir}`)
  return runDir
}

// Packs and run folders must live outside this repo, or below its git-ignored analysis/ folder:
// packs can hold personal customer data, and nothing under analysis/ is ever committed.
function assertOutsideRepo(path, what) {
  const real = realpathSync(path)
  const repo = realpathSync(REPO_ROOT)
  const analysis = `${repo}/analysis/`
  if (real.startsWith(analysis)) return
  if (real === repo || real.startsWith(`${repo}/`)) {
    throw new Error(`${what} must not be inside the swarm-sim repo, except below analysis/: ${path}`)
  }
}

// An existing run folder, which must sit directly under a `runs` folder.
function runFolder(runDirInput) {
  const runDir = existingRunDir(runDirInput)
  assertOutsideRepo(runDir, 'runDir')
  if (basename(dirname(runDir)) !== 'runs') throw new Error(`runDir must be <packDir>/runs/<run folder>: ${runDir}`)
  return runDir
}

// ---------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------

function today() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function isRealDate(text) {
  const parsed = new Date(`${text}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(text)
}

// Creates <packDir>/runs/<date>-<slug>, or -2, -3 and so on when it exists. Never reuses a folder.
function createRunDir(packDir, date, slug) {
  const runsDir = join(packDir, 'runs')
  mkdirSync(runsDir, { recursive: true })
  for (let n = 1; ; n++) {
    const runDir = join(runsDir, n === 1 ? `${date}-${slug}` : `${date}-${slug}-${n}`)
    try {
      mkdirSync(runDir)
    } catch (e) {
      if (e.code === 'EEXIST') continue
      throw e
    }
    for (const sub of SUBFOLDERS) mkdirSync(join(runDir, sub))
    return runDir
  }
}

/** Creates a new run folder for a pack and returns the args for the swarm-prepare workflow. */
export function prepareArgs(packDirInput, slug, { date = today() } = {}) {
  if (!packDirInput) throw new Error('packDir is required')
  if (typeof slug !== 'string' || !SLUG.test(slug)) {
    throw new Error(`slug must be letters, digits, ".", "_" or "-", starting with a letter or digit: ${slug}`)
  }
  if (!DATE.test(date) || !isRealDate(date)) throw new Error(`date must be a real date as YYYY-MM-DD: ${date}`)

  const packDir = absolutePath(packDirInput)
  if (!isDirectory(packDir)) throw new Error(`packDir does not exist or is not a folder: ${packDir}`)
  assertOutsideRepo(packDir, 'packDir')

  // Top-level files only. runs/ and every other subfolder is never listed, so old runs are not extracted.
  const isPackDoc = (path, name) => name.endsWith('.md') && !name.startsWith('.') && isFile(path)
  const files = listNames(packDir, isPackDoc).map((name) => join(packDir, name))
  if (files.length === 0) throw new Error(`packDir has no top-level .md file: ${packDir}`)

  const runDir = createRunDir(packDir, date, slug)
  return { packDir, runDir, files, referencesDir: REFERENCES_DIR }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

// A persona's name is a role label built from its cohort id, never a personal name.
// Keep in sync with personaName() in .claude/workflows/swarm-prepare.js.
export function personaName(cohortId, n) {
  const words = cohortId
    .replace(/_Representative$/, '')
    .split('_')
    .flatMap((part) => part.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' '))
    .filter(Boolean)
  return `${words.join(' ')} ${n}`
}

// One {id, cohortId, name} for each persona file the plan calls for, in plan cohort order then n order.
function expectedPersonas(plan) {
  const expected = []
  for (const cohort of plan.cohorts) {
    if (cohort?.role !== 'actor' || !(cohort.personaCount > 0)) continue
    if (typeof cohort.id !== 'string' || cohort.id === '' || !Number.isInteger(cohort.personaCount)) {
      throw new Error(`plan.json cohort "${cohort.id}" needs a text id and a whole-number personaCount`)
    }
    for (let n = 1; n <= cohort.personaCount; n++) {
      expected.push({ id: `${cohort.id}-${n}`, cohortId: cohort.id, name: personaName(cohort.id, n) })
    }
  }
  return expected
}

// Loads exactly the expected persona files. Names every missing, extra, unreadable or mislabeled file.
function loadPersonas(runDir, expected) {
  const personasDir = join(runDir, 'personas')
  const present = new Set(listNames(personasDir, (_, name) => !IGNORED_PERSONA_ENTRIES.has(name)))
  const expectedNames = new Set(expected.map((p) => `${p.id}.json`))
  const missing = [...expectedNames].filter((name) => !present.has(name))
  const extra = [...present].filter((name) => !expectedNames.has(name))

  const personas = []
  const unreadable = []
  const mislabeled = []
  const misnamed = []
  for (const { id, cohortId, name: expectedName } of expected) {
    const name = `${id}.json`
    if (!present.has(name)) continue
    const persona = attempt(() => readJson(join(personasDir, name), name), unreadable)
    if (persona === undefined) continue
    if (persona?.id !== id || persona?.cohortId !== cohortId) mislabeled.push(name)
    else if (persona.name !== expectedName) misnamed.push(`${name} (name must be "${expectedName}")`)
    else personas.push(persona)
  }

  const problems = []
  if (missing.length > 0) problems.push(`missing: ${missing.join(', ')}`)
  if (extra.length > 0) problems.push(`extra: ${extra.join(', ')}`)
  if (unreadable.length > 0) problems.push(`unreadable: ${unreadable.join(', ')}`)
  if (mislabeled.length > 0) {
    problems.push(`id or cohortId inside the file does not match its name: ${mislabeled.join(', ')}`)
  }
  if (misnamed.length > 0) problems.push(`name is not the role label: ${misnamed.join(', ')}`)
  if (problems.length > 0) throw new Error(`personas/ does not match plan.json: ${problems.join('; ')}`)
  return personas
}

/**
 * Checks a prepared run folder, writes its facts.json and returns the args for the swarm-run workflow.
 * Personas and facts go by reference: the workflow gets their file paths, not their content.
 */
export function runArgs(runDirInput) {
  const runDir = runFolder(runDirInput)
  // A new run starts here, so the main loop's files from an earlier run can never be current. sim/ and
  // analysis/ stay: a resumed workflow replays cached agents and does not rewrite their logs.
  for (const name of STALE_ON_RUN) rmSync(join(runDir, name), { force: true })

  const problems = []
  const plan = attempt(() => readJson(join(runDir, 'plan.json'), 'plan.json'), problems)
  const ontology = attempt(() => readJson(join(runDir, 'ontology.json'), 'ontology.json'), problems)
  if (plan !== undefined && !Array.isArray(plan?.cohorts)) problems.push('plan.json has no cohorts list')
  if (ontology !== undefined && !Array.isArray(ontology?.claims)) problems.push('ontology.json has no claims list')
  if (problems.length > 0) throw new Error(`${problems.join('; ')} (run folder ${runDir})`)

  const personas = loadPersonas(runDir, expectedPersonas(plan))
  const personaRefs = personas.map(({ id, cohortId, relatedIds }) => ({
    id,
    cohortId,
    path: join(runDir, 'personas', `${id}.json`),
    // The workflow cannot read files, and social mode ranks each persona's feed by relatedIds.
    relatedIds: Array.isArray(relatedIds) ? relatedIds : [],
  }))

  const facts = ontology.claims.filter((claim) => claim.status === 'Fact').map(({ text, source }) => ({ text, source }))
  const factsPath = join(runDir, 'facts.json')
  writeFileSync(factsPath, `${JSON.stringify(facts, null, 2)}\n`)

  return { packDir: dirname(dirname(runDir)), runDir, plan, personaRefs, factsPath, referencesDir: REFERENCES_DIR }
}

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

// The only files `save` writes. Subagents cannot write report files, so the main loop saves them.
const LATER_CHECKS = ['check-2.json', 'check-3.json']
const STALE_ON_RUN = ['report.md', 'report.final.md', 'check.json', ...LATER_CHECKS, 'run-result.json']
const SAVED_FILES = ['report.md', 'check.json', 'report.final.md', ...LATER_CHECKS]

/**
 * Writes the `files` of a swarm-run workflow result (read from a JSON file) into its run folder.
 * Checks every entry before it writes any. Returns the written file names and the report.final.md path.
 */
export function saveArgs(runDirInput, resultPathInput) {
  const runDir = runFolder(runDirInput)
  if (!isFile(join(runDir, 'plan.json'))) throw new Error(`plan.json is missing (run folder ${runDir})`)
  if (!resultPathInput) throw new Error('resultJsonPath is required')
  const result = readJson(absolutePath(resultPathInput))

  const files = result?.files
  if (files === null || typeof files !== 'object' || Array.isArray(files)) throw new Error('result has no files object')
  const entries = Object.entries(files)
  const unknown = entries.map(([name]) => name).filter((name) => !SAVED_FILES.includes(name))
  if (unknown.length > 0) throw new Error(`files may only be ${SAVED_FILES.join(', ')}; not allowed: ${unknown.join(', ')}`)
  const invalid = entries.filter(([, content]) => content === null || !['string', 'object'].includes(typeof content))
  if (invalid.length > 0) {
    throw new Error(`file content must be text or JSON, not null or a number or boolean: ${invalid.map(([name]) => name).join(', ')}`)
  }

  for (const [name, content] of entries) {
    writeFileSync(join(runDir, name), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`)
  }
  const written = entries.map(([name]) => name)
  if (written.includes('check.json')) {
    for (const name of LATER_CHECKS) if (!written.includes(name)) rmSync(join(runDir, name), { force: true })
  }
  return { written, reportFinalPath: written.includes('report.final.md') ? join(runDir, 'report.final.md') : null }
}

// ---------------------------------------------------------------------------
// interview
// ---------------------------------------------------------------------------

// Every line of sim/<variant>/<personaId>.jsonl, tagged with its variant and its citation.
function journeyLogs(file, variant, personaId) {
  const logs = []
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((text, i) => {
      if (text.trim() === '') return
      let line
      try {
        line = JSON.parse(text)
      } catch (e) {
        throw new Error(`${file} line ${i + 1} is not valid JSON (${e.message})`)
      }
      logs.push({ ...line, kind: 'journey', variant, citation: `${variant}/${personaId}:${line.step}` })
    })
  return logs
}

// Every action by this persona in sim/<variant>/round-<n>/*.json, tagged with its variant and citation.
function socialLogs(variantDir, variant, personaId) {
  const logs = []
  const rounds = listNames(variantDir, (path, name) => /^round-\d+$/.test(name) && isDirectory(path))
  for (const roundName of rounds) {
    const round = Number(roundName.slice('round-'.length))
    const roundDir = join(variantDir, roundName)
    for (const name of listNames(roundDir, (path, file) => file.endsWith('.json') && isFile(path))) {
      const file = join(roundDir, name)
      const data = readJson(file)
      if (!Array.isArray(data?.actions)) throw new Error(`${file} has no actions list`)
      for (const action of data.actions) {
        if (action.personaId !== personaId) continue
        logs.push({ ...action, kind: 'social', variant, round, citation: `${variant}/${roundName}/${action.id}` })
      }
    }
  }
  return logs
}

/** Loads one persona and all of its simulation log lines, across variants, for an interview. */
export function interviewArgs(runDirInput, personaId) {
  const runDir = existingRunDir(runDirInput)
  const isPlainName = typeof personaId === 'string' && personaId !== '' && personaId !== '..' && personaId === basename(personaId)
  if (!isPlainName) throw new Error(`personaId must be a persona id, not a path: ${personaId}`)

  const personaFile = join(runDir, 'personas', `${personaId}.json`)
  if (!isFile(personaFile)) throw new Error(`persona file not found: ${personaFile}`)
  const persona = readJson(personaFile)

  const logs = []
  const simDir = join(runDir, 'sim')
  for (const variant of listNames(simDir, (path) => isDirectory(path))) {
    const variantDir = join(simDir, variant)
    const journeyFile = join(variantDir, `${personaId}.jsonl`)
    if (isFile(journeyFile)) logs.push(...journeyLogs(journeyFile, variant, personaId))
    logs.push(...socialLogs(variantDir, variant, personaId))
  }
  return { persona, logs }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const usage = (text) => new Error(`usage: node scripts/swarm-args.mjs ${text}`)

/** Runs one CLI command (the arguments after the script name) and returns its JSON result or throws. */
export function runCli(argv) {
  const [command, ...rest] = argv
  const parse = (options) => parseArgs({ args: rest, options, allowPositionals: true })
  if (command === 'prepare') {
    const { values, positionals } = parse({ date: { type: 'string' } })
    if (positionals.length !== 2) throw usage('prepare <packDir> <slug> [--date YYYY-MM-DD]')
    return prepareArgs(positionals[0], positionals[1], { date: values.date })
  }
  if (command === 'run') {
    const { positionals } = parse({})
    if (positionals.length !== 1) throw usage('run <runDir>')
    return runArgs(positionals[0])
  }
  if (command === 'save') {
    const { positionals } = parse({})
    if (positionals.length !== 2) throw usage('save <runDir> <resultJsonPath>')
    return saveArgs(positionals[0], positionals[1])
  }
  if (command === 'interview') {
    const { positionals } = parse({})
    if (positionals.length !== 2) throw usage('interview <runDir> <personaId>')
    return interviewArgs(positionals[0], positionals[1])
  }
  throw usage('<prepare|run|save|interview> ...')
}

function main(argv) {
  try {
    process.stdout.write(`${JSON.stringify(runCli(argv))}\n`)
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ error: e.message })}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(SCRIPT_PATH)) {
  main(process.argv.slice(2))
}
