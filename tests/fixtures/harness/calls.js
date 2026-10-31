export const meta = { name: 'calls', description: 'records calls', phases: [{ title: 'First' }, { title: 'Second' }] }

const pre = await agent('before any phase', { label: 'pre' })
phase('First')
const a = await agent('prompt a', { label: 'a', model: 'sonnet' })
phase('Second')
const b = await agent('prompt b', { label: 'b', model: 'opus' })
const c = await agent('prompt c', { label: 'c', phase: 'Custom' })
return { pre, a, b, c }
