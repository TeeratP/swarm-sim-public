import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { fakeParallel, fakePipeline, loadWorkflow, run, variantTextCount } from './harness.js'

const fx = (name) => fileURLToPath(new URL(`./fixtures/harness/${name}`, import.meta.url))

test('loadWorkflow extracts meta and strips the export keyword', () => {
  const { meta, body } = loadWorkflow(fx('returns.js'))
  assert.deepEqual(meta, { name: 'returns', description: 'returns a value', phases: [{ title: 'Only' }] })
  assert.match(body, /^const meta = /m)
  assert.doesNotMatch(body, /\bexport\b/)
})

test('loadWorkflow handles braces in strings, templates and comments', () => {
  const { meta } = loadWorkflow(fx('braces.js'))
  assert.equal(meta.name, 'braces')
  assert.equal(meta.description, 'has } and { in a string, "quotes" and `ticks`')
  assert.equal(meta.note, 'a closing } and an escaped " quote')
  assert.equal(meta.other, "it's a } too")
  assert.equal(meta.tmpl, 'template with } and { and nested } inside')
  assert.deepEqual(meta.phases, [{ title: 'A {x}' }, { title: 'B' }])
})

test('loadWorkflow ignores an export meta line inside a comment and keeps the body runnable', async () => {
  const { result, error } = await run(fx('braces.js'))
  assert.ifError(error)
  assert.deepEqual(result, ['A {x}', 'B'])
})

test('loadWorkflow throws when there is no meta', () => {
  assert.throws(() => loadWorkflow(fx('no-meta.js')), /no "export const meta =" found/)
})

test('run returns the script value, meta, args, phases and logs', async () => {
  const r = await run(fx('returns.js'), { args: { files: ['a.md'] } })
  assert.ifError(r.error)
  assert.deepEqual(r.result, { answer: 42, args: { files: ['a.md'] } })
  assert.equal(r.meta.name, 'returns')
  assert.deepEqual(r.phases, ['Only'])
  assert.deepEqual(r.logs, ['hello', 'world'])
  assert.deepEqual(r.calls, [])
})

test('run records every call with prompt, opts and phase', async () => {
  const r = await run(fx('calls.js'), { responder: (prompt) => `reply:${prompt}` })
  assert.ifError(r.error)
  assert.deepEqual(r.calls, [
    { prompt: 'before any phase', opts: { label: 'pre' }, phase: null },
    { prompt: 'prompt a', opts: { label: 'a', model: 'sonnet' }, phase: 'First' },
    { prompt: 'prompt b', opts: { label: 'b', model: 'opus' }, phase: 'Second' },
    { prompt: 'prompt c', opts: { label: 'c', phase: 'Custom' }, phase: 'Custom' },
  ])
  assert.deepEqual(r.phases, ['First', 'Second'])
  assert.deepEqual(r.result, {
    pre: 'reply:before any phase',
    a: 'reply:prompt a',
    b: 'reply:prompt b',
    c: 'reply:prompt c',
  })
})

test('responder gets prompt, opts and call index, and wins over fixtures', async () => {
  const seen = []
  const r = await run(fx('lookup.js'), {
    args: { labels: ['x', 'y'] },
    fixtures: { x: 'from fixture', y: 'from fixture' },
    responder: async (prompt, opts, index) => {
      seen.push([prompt, opts.label, index])
      return `r${index}`
    },
  })
  assert.ifError(r.error)
  assert.deepEqual(r.result, ['r0', 'r1'])
  assert.deepEqual(seen, [
    ['prompt for x', 'x', 0],
    ['prompt for y', 'y', 1],
  ])
})

test('fixtures: exact label beats prefix', async () => {
  const r = await run(fx('lookup.js'), {
    args: { labels: ['actor:A', 'actor:B'] },
    fixtures: { 'actor:': 'prefix', 'actor:A': 'exact' },
  })
  assert.ifError(r.error)
  assert.deepEqual(r.result, ['exact', 'prefix'])
})

test('fixtures: the longest prefix ending in a colon wins', async () => {
  const r = await run(fx('lookup.js'), {
    args: { labels: ['actor:A:p1', 'actor:B:p1'] },
    fixtures: { 'actor:': 'short', 'actor:A:': 'long' },
  })
  assert.ifError(r.error)
  assert.deepEqual(r.result, ['long', 'short'])
})

test('fixtures: a function fixture gets prompt and opts', async () => {
  const r = await run(fx('lookup.js'), {
    args: { labels: ['echo:1'] },
    fixtures: { 'echo:': (prompt, opts) => ({ prompt, label: opts.label }) },
  })
  assert.ifError(r.error)
  assert.deepEqual(r.result, [{ prompt: 'prompt for echo:1', label: 'echo:1' }])
})

test('fixtures: plain values are deep-cloned per call', async () => {
  const fixtures = { x: { list: [1, 2] } }
  const r = await run(fx('lookup.js'), { args: { labels: ['x', 'x'] }, fixtures })
  assert.ifError(r.error)
  assert.deepEqual(r.result[0], { list: [1, 2] })
  assert.notEqual(r.result[0], r.result[1])
  assert.notEqual(r.result[0], fixtures.x)
  assert.notEqual(r.result[0].list, fixtures.x.list)
})

test('fixtures: a missing fixture errors naming the label, with the call recorded', async () => {
  const r = await run(fx('lookup.js'), {
    args: { labels: ['known', 'plan-2'] },
    fixtures: { known: 1, plan: 'no colon, so not a prefix' },
  })
  assert.match(r.error.message, /no fixture for agent label "plan-2"/)
  assert.equal(r.result, undefined)
  assert.deepEqual(r.calls.map((c) => c.opts.label), ['known', 'plan-2'])
})

test('a null fixture or responder result simulates a dead agent', async () => {
  const viaFixture = await run(fx('lookup.js'), { args: { labels: ['dead:1'] }, fixtures: { 'dead:': null } })
  assert.ifError(viaFixture.error)
  assert.deepEqual(viaFixture.result, [null])

  const viaResponder = await run(fx('lookup.js'), { args: { labels: ['x'] }, responder: () => null })
  assert.ifError(viaResponder.error)
  assert.deepEqual(viaResponder.result, [null])
})

test('parallel turns a throwing thunk and a null agent into null, keeping order', async () => {
  const r = await run(fx('parallel.js'), {
    fixtures: { 'item:1': 'one', 'item:3': 'three', 'item:4': null },
  })
  assert.ifError(r.error)
  assert.deepEqual(r.result, ['one', null, 'three', null])
  assert.deepEqual(r.calls.map((c) => c.opts.label), ['item:1', 'item:3', 'item:4'])
})

test('fakeParallel runs thunks in order and rejects non-thunks', async () => {
  const order = []
  const out = await fakeParallel([
    async () => order.push('a'),
    () => {
      order.push('b')
      throw new Error('x')
    },
    () => order.push('c'),
  ])
  assert.deepEqual(out, [1, null, 3])
  assert.deepEqual(order, ['a', 'b', 'c'])
  await assert.rejects(fakeParallel([Promise.resolve(1)]), /expects an array of thunks/)
})

test('pipeline passes (item, item, index) to stage 1 and (prev, original, index) later, and nulls a throwing item', async () => {
  const r = await run(fx('pipeline.js'))
  assert.ifError(r.error)
  assert.deepEqual(r.result.out, ['A!?', null, 'C!?'])
  assert.deepEqual(r.result.seen, [
    ['s1', 'a', 'a', 0],
    ['s2', 'A', 'a', 0],
    ['s3', 'A!', 'a', 0],
    ['s1', 'b', 'b', 1],
    ['s2', 'B', 'b', 1],
    ['s1', 'c', 'c', 2],
    ['s2', 'C', 'c', 2],
    ['s3', 'C!', 'c', 2],
  ])
})

test('fakePipeline with no stages returns the items', async () => {
  assert.deepEqual(await fakePipeline([1, 2]), [1, 2])
})

test('a throwing script returns error and the calls made so far', async () => {
  const r = await run(fx('throws.js'), { fixtures: { first: 'ok' } })
  assert.ok(r.error instanceof Error)
  assert.equal(r.error.message, 'script failed')
  assert.equal(r.result, undefined)
  assert.deepEqual(r.calls, [{ prompt: 'first', opts: { label: 'first' }, phase: 'Start' }])
  assert.deepEqual(r.phases, ['Start'])
  assert.deepEqual(r.logs, ['before'])
  assert.equal(r.meta.name, 'throws')
})

test('budget is unlimited and nested workflow() throws', async () => {
  const ok = await run(fx('globals.js'))
  assert.ifError(ok.error)
  assert.deepEqual(ok.result, { total: null, spent: 0, remaining: Infinity })

  const nested = await run(fx('globals.js'), { args: { nested: true } })
  assert.equal(nested.error.message, 'nested workflow not supported in harness')
})

test('variantTextCount counts distinct variant descriptions in a prompt', () => {
  const variants = ['Free shipping on all orders', 'Join the waitlist today']
  assert.equal(variantTextCount('hello', variants), 0)
  assert.equal(variantTextCount('intro. Free shipping on all orders. outro', variants), 1)
  assert.equal(variantTextCount('Join the waitlist today / Free shipping on all orders', variants), 2)
  assert.equal(variantTextCount('Free shipping on all orders Free shipping on all orders', variants), 1)
})
