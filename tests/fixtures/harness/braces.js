// export const meta = { not: 'the real one' }
export const meta = {
  name: 'braces',
  description: 'has } and { in a string, "quotes" and `ticks`',
  note: "a closing } and an escaped \" quote",
  other: 'it\'s a } too',
  tmpl: `template with } and ${'{'} and ${`nested ${'}'}`} inside`,
  // a comment with a stray } brace
  /* and a block comment with { */
  phases: [{ title: 'A {x}' }, { title: 'B' }],
}

return meta.phases.map((p) => p.title)
