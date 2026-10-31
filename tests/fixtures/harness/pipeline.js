export const meta = { name: 'pipeline', description: 'three-stage pipeline, stage 2 throws for b', phases: [{ title: 'Flow' }] }

phase('Flow')
const seen = []
const out = await pipeline(
  ['a', 'b', 'c'],
  (item, orig, idx) => {
    seen.push(['s1', item, orig, idx])
    return item.toUpperCase()
  },
  (prev, orig, idx) => {
    seen.push(['s2', prev, orig, idx])
    if (orig === 'b') throw new Error('stage 2 fails for b')
    return prev + '!'
  },
  (prev, orig, idx) => {
    seen.push(['s3', prev, orig, idx])
    return prev + '?'
  },
)
return { out, seen }
