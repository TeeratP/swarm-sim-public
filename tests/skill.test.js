import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareArgs, runArgs, saveArgs } from '../scripts/swarm-args.mjs'
import { loadWorkflow } from './harness.js'

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url))
const SKILL = path('../.claude/skills/swarm-sim/SKILL.md')
const PREPARE = path('../.claude/workflows/swarm-prepare.js')
const RUN = path('../.claude/workflows/swarm-run.js')

const skill = readFileSync(SKILL, 'utf8')

// Returns the top-level `key: value` pairs of a Markdown file's frontmatter.
function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
  assert.ok(match, 'SKILL.md starts with a frontmatter block')
  const fields = {}
  for (const line of match[1].split('\n')) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (pair) fields[pair[1]] = pair[2].trim()
  }
  return fields
}

// Returns the fields a workflow reads from `args`, by `args.x` and by `const { x, y = 1 } = args`.
// Comments are removed first, so a header comment cannot add a field.
function argsFields(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const fields = new Set()
  for (const match of code.matchAll(/\bargs\.(\w+)/g)) fields.add(match[1])
  for (const match of code.matchAll(/\{([^{}]*)\}\s*=\s*args\b/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/[\s=:]/)[0]
      if (name) fields.add(name)
    }
  }
  return fields
}

test('argsFields reads both args.x and destructured fields, and ignores comments', () => {
  const source = [
    '// args.ignoredLine',
    '/* args.ignoredBlock */',
    'const { a, b = [], c: renamed } = args',
    'const d = args.d.trim()',
  ].join('\n')

  assert.deepEqual([...argsFields(source)].sort(), ['a', 'b', 'c', 'd'])
})

test('SKILL.md frontmatter has the name swarm-sim and a description that names its triggers', () => {
  const { name, description } = frontmatter(skill)

  assert.equal(name, 'swarm-sim')
  assert.ok(description, 'description is not empty')
  for (const trigger of ['/swarm-sim', 'swarm simulation', 'MiroFish-style simulation', 'simulate personas reacting to a scenario']) {
    assert.ok(description.includes(trigger), `description mentions "${trigger}"`)
  }
})

test('SKILL.md covers both workflows, all three commands, resume and the CLI', () => {
  assert.equal(loadWorkflow(PREPARE).meta.name, 'swarm-prepare')
  assert.equal(loadWorkflow(RUN).meta.name, 'swarm-run')
  for (const needle of [
    'swarm-prepare',
    'swarm-run',
    '/swarm-sim prepare <packDir> <slug>',
    '/swarm-sim run <runDir>',
    '/swarm-sim interview <runDir> <personaId>',
    'scripts/swarm-args.mjs',
    'swarm-args.mjs save <runDir> <runDir>/run-result.json',
    'resumeFromRunId',
    'scriptPath',
    'AskUserQuestion',
    'git -C',
    'rev-parse --show-toplevel',
  ]) {
    assert.ok(skill.includes(needle), `SKILL.md mentions ${needle}`)
  }
  assert.ok(existsSync(path('../scripts/swarm-args.mjs')), 'scripts/swarm-args.mjs exists')
})

test('SKILL.md saves the swarm-run result through the CLI and does not expect a report path from the workflow', () => {
  const runSource = readFileSync(RUN, 'utf8')

  assert.ok(skill.includes('`files`'), 'SKILL.md names the files the workflow returns')
  assert.ok(skill.includes('Write tool'), 'the main loop writes run-result.json')
  assert.ok(skill.includes('report.final.md'))
  assert.ok(!skill.includes('reportPath'), 'the workflow no longer returns reportPath')
  assert.ok(!runSource.includes('reportPath'), 'swarm-run no longer returns reportPath')
})

test('SKILL.md has one section per command, plus resume and data safety', () => {
  const headings = [...skill.matchAll(/^## (.+)$/gm)].map((match) => match[1])

  for (const heading of ['prepare', 'run', 'interview', 'Resume', 'Data safety']) {
    assert.ok(headings.includes(heading), `a "## ${heading}" section exists`)
  }
})

// Runs the prepare, run and save CLI commands on a minimal valid pack and returns what each one prints:
// the workflows with their args, and what save prints. The run folder has one actor cohort and one persona.
function cliOutputs(t) {
  const root = mkdtempSync(join(tmpdir(), 'swarm-skill-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const packDir = join(root, 'pack')
  mkdirSync(packDir)
  writeFileSync(join(packDir, 'scenario.md'), '# scenario\n')
  const prepareOut = prepareArgs(packDir, 'slug', { date: '2026-10-31' })

  // swarm-run input: a minimal valid run folder with one actor cohort and one persona.
  const runDir = join(packDir, 'runs', '2026-10-31-run')
  mkdirSync(join(runDir, 'personas'), { recursive: true })
  const plan = { mode: 'journey', cohorts: [{ id: 'c', entityId: 'c', role: 'actor', personaCount: 1, reason: 'r' }] }
  writeFileSync(join(runDir, 'plan.json'), JSON.stringify(plan))
  writeFileSync(join(runDir, 'ontology.json'), JSON.stringify({ claims: [{ text: 't', status: 'Fact', source: 's:1' }] }))
  writeFileSync(join(runDir, 'personas', 'c-1.json'), JSON.stringify({ id: 'c-1', cohortId: 'c', name: 'c 1' }))
  const runOut = runArgs(runDir)

  const resultPath = join(root, 'run-result.json')
  writeFileSync(resultPath, JSON.stringify({ files: { 'report.md': 'text', 'report.final.md': 'text' } }))
  const saveOut = saveArgs(runDir, resultPath)

  return {
    workflows: [
      [PREPARE, prepareOut],
      [RUN, runOut],
    ],
    saveOut,
  }
}

test('every args field a workflow reads is in the output of the CLI command that feeds it', (t) => {
  for (const [script, output] of cliOutputs(t).workflows) {
    const fields = argsFields(readFileSync(script, 'utf8'))
    assert.ok(fields.size > 0, `${script} reads at least one args field`)
    const missing = [...fields].filter((field) => !Object.hasOwn(output, field))
    assert.deepEqual(missing, [], `${script} reads args fields the CLI does not output: ${missing.join(', ')}`)
  }
})

test('swarm-run takes personas and facts by reference, and SKILL.md lists exactly the keys each CLI command prints', (t) => {
  const {
    workflows: [[, prepareOut], [runScript, runOut]],
    saveOut,
  } = cliOutputs(t)

  const fields = argsFields(readFileSync(runScript, 'utf8'))
  assert.ok(fields.has('personaRefs') && fields.has('factsPath'))
  assert.ok(!fields.has('personas') && !fields.has('facts'), 'swarm-run no longer reads inline personas or facts')
  assert.equal(Object.hasOwn(runOut, 'personas'), false)
  assert.equal(Object.hasOwn(runOut, 'facts'), false)

  for (const output of [prepareOut, runOut, saveOut]) {
    const keys = `{${Object.keys(output).join(', ')}}`
    assert.ok(skill.includes(keys), `SKILL.md lists ${keys}`)
  }
})
