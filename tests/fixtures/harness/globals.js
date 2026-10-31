export const meta = { name: 'globals', description: 'reads budget and calls workflow', phases: [{ title: 'Globals' }] }

phase('Globals')
const snapshot = { total: budget.total, spent: budget.spent(), remaining: budget.remaining() }
if (args.nested) await workflow('other', {})
return snapshot
