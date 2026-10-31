// Test harness for Claude Code Workflow scripts. Loads a script, runs it against fake
// agent/parallel/pipeline/phase/log/budget/workflow globals, and records every agent call.
import { readFileSync } from 'node:fs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

// Scanner helpers: each takes the index of an opening token and returns the index just past
// its end. Used to find the end of the `meta` literal without being fooled by braces in
// strings, template literals or comments. Regex literals are not handled (meta is a pure
// literal, so it should not contain any).
function skipQuoted(src, i) {
  const quote = src[i]
  i++
  while (i < src.length) {
    if (src[i] === '\\') i += 2
    else if (src[i] === quote) return i + 1
    else i++
  }
  throw new Error(`unterminated ${quote} string in meta`)
}

function skipTemplate(src, i) {
  i++
  while (i < src.length) {
    if (src[i] === '\\') i += 2
    else if (src[i] === '`') return i + 1
    else if (src[i] === '$' && src[i + 1] === '{') i = skipBraces(src, i + 1)
    else i++
  }
  throw new Error('unterminated template literal in meta')
}

function skipBraces(src, i) {
  let depth = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '"' || c === "'") i = skipQuoted(src, i)
    else if (c === '`') i = skipTemplate(src, i)
    else if (c === '/' && src[i + 1] === '/') {
      const newline = src.indexOf('\n', i)
      i = newline === -1 ? src.length : newline
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end === -1) throw new Error('unterminated block comment in meta')
      i = end + 2
    } else {
      i++
      if (c === '{') depth++
      else if (c === '}' && --depth === 0) return i
    }
  }
  throw new Error('unbalanced braces in meta')
}

/** Reads a workflow script and returns its evaluated `meta` plus a body with `export` removed. */
export function loadWorkflow(path) {
  const source = readFileSync(path, 'utf8')
  const match = /^export\s+const\s+meta\s*=\s*/m.exec(source)
  if (!match) throw new Error(`${path}: no "export const meta =" found`)
  const start = match.index + match[0].length
  if (source[start] !== '{') throw new Error(`${path}: meta must be an object literal`)
  const literal = source.slice(start, skipBraces(source, start))
  const meta = new Function('return (' + literal + ')')()
  const body = source.slice(0, match.index) + source.slice(match.index).replace(/^export\s+/, '')
  return { meta, body }
}

/** Stand-in for `parallel()`: runs thunks one by one in order; a thunk that throws yields null. */
export async function fakeParallel(thunks) {
  const results = []
  for (const thunk of thunks) {
    if (typeof thunk !== 'function') throw new TypeError('parallel() expects an array of thunks')
    try {
      results.push(await thunk())
    } catch {
      results.push(null)
    }
  }
  return results
}

/**
 * Stand-in for `pipeline()`: runs each item through every stage in item order. Stage 1 gets
 * (item, item, index), later stages (previousResult, item, index). A stage that throws makes
 * that item null and skips its remaining stages.
 */
export async function fakePipeline(items, ...stages) {
  const results = []
  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    let value = item
    try {
      for (const stage of stages) value = await stage(value, item, index)
    } catch {
      value = null
    }
    results.push(value)
  }
  return results
}

/** Returns how many of the given variant description strings appear in the prompt. */
export function variantTextCount(prompt, variants) {
  return variants.filter((text) => prompt.includes(text)).length
}

// Exact label first, then the longest key that ends in ':' and is a prefix of the label.
function findFixture(fixtures, label) {
  if (typeof label !== 'string') return { found: false }
  if (Object.hasOwn(fixtures, label)) return { found: true, value: fixtures[label] }
  let best = null
  for (const key of Object.keys(fixtures)) {
    if (key.endsWith(':') && label.startsWith(key) && (best === null || key.length > best.length)) {
      best = key
    }
  }
  return best === null ? { found: false } : { found: true, value: fixtures[best] }
}

/**
 * Runs a workflow script against fakes. Agent results come from `responder(prompt, opts, callIndex)`
 * if given, else from `fixtures` keyed by label. A script that throws yields `error` (and no
 * `result`) alongside the calls made so far.
 */
export async function run(path, { args = {}, responder, fixtures = {} } = {}) {
  const { meta, body } = loadWorkflow(path)
  const fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow', body)
  const calls = []
  const phases = []
  const logs = []
  let currentPhase = null

  async function agent(prompt, opts = {}) {
    const callIndex = calls.length
    calls.push({ prompt, opts, phase: opts.phase ?? currentPhase })
    if (responder) return responder(prompt, opts, callIndex)
    const fixture = findFixture(fixtures, opts.label)
    if (!fixture.found) throw new Error(`harness: no fixture for agent label "${opts.label}"`)
    return typeof fixture.value === 'function' ? fixture.value(prompt, opts) : structuredClone(fixture.value)
  }

  function phase(title) {
    phases.push(title)
    currentPhase = title
  }

  const log = (message) => {
    logs.push(message)
  }

  const budget = { total: null, spent: () => 0, remaining: () => Infinity }

  const workflow = () => {
    throw new Error('nested workflow not supported in harness')
  }

  let result
  let error
  try {
    result = await fn(agent, fakeParallel, fakePipeline, phase, log, args, budget, workflow)
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e))
  }
  return { result, error, calls, phases, logs, meta }
}
