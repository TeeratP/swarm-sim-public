export const meta = { name: 'lookup', description: 'one agent call per label in args.labels', phases: [{ title: 'Lookup' }] }

phase('Lookup')
const out = []
for (const label of args.labels) out.push(await agent('prompt for ' + label, { label }))
return out
