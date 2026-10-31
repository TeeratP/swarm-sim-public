export const meta = { name: 'returns', description: 'returns a value', phases: [{ title: 'Only' }] }

phase('Only')
log('hello')
log('world')
return { answer: 42, args }
