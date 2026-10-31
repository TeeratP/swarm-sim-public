export const meta = { name: 'parallel', description: 'parallel with a throwing and a null thunk', phases: [{ title: 'Fan out' }] }

phase('Fan out')
return await parallel([
  () => agent('one', { label: 'item:1' }),
  () => {
    throw new Error('boom')
  },
  () => agent('three', { label: 'item:3' }),
  () => agent('four', { label: 'item:4' }),
])
