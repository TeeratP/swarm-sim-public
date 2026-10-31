export const meta = { name: 'throws', description: 'throws after one call', phases: [{ title: 'Start' }] }

phase('Start')
log('before')
await agent('first', { label: 'first' })
throw new Error('script failed')
await agent('never reached', { label: 'second' })
