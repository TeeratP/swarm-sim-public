export const meta = {
  name: 'swarm-prepare',
  description: 'Build an ontology, a simulation plan and personas from a seed pack',
  phases: [{ title: 'Extract' }, { title: 'Merge' }, { title: 'Plan' }, { title: 'Personas' }],
}

/*
 * swarm-prepare: extract an ontology from a seed pack, plan the simulation, write the personas.
 * The script holds control flow only. Agents read and write every file.
 *
 * args:
 *   packDir        absolute path of the seed pack.
 *   runDir         absolute path of the run folder. The skill creates it first.
 *   files          absolute paths of the pack's top-level .md files (never runs/).
 *   referencesDir  absolute path of .claude/skills/swarm-sim/references/ in the swarm-sim repo.
 *                  The script cannot learn the repo path, so the skill passes it.
 *
 * Agents write <runDir>/ontology.json, <runDir>/plan.json and <runDir>/personas/<personaId>.json.
 *
 * Returns {error} when it stops early, else {mode, variants, cohorts, personas: [{id, name, slant}],
 * plannedSimulationCalls, dropped, problems: {nullExtractors, droppedPersonas, nullPersonaAgents}}.
 */

const str = { type: 'string' }
const int = { type: 'integer' }
const strList = { type: 'array', items: str }
const STATUS = { type: 'string', enum: ['Fact', 'Assumption', 'Hypothesis', 'Unknown'] }
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties) })
const list = (properties) => ({ type: 'array', items: obj(properties) })

const ENTITIES = list({ id: str, type: str, name: str, summary: str, source: str })
const RELATIONS = list({ from: str, to: str, type: str, status: STATUS, source: str })
const CLAIMS = list({ text: str, status: STATUS, source: str })

const EXTRACT_SCHEMA = obj({ entities: ENTITIES, relations: RELATIONS, claims: CLAIMS })
const MERGE_SCHEMA = obj({
  entityTypes: list({ name: str, description: str }),
  entities: ENTITIES,
  relations: RELATIONS,
  claims: CLAIMS,
})
// Nothing is required at the root, so the plan agent can return {error} alone.
// The script checks the plan fields itself (planProblem).
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    error: str,
    mode: { type: 'string', enum: ['journey', 'social'] },
    variants: list({ id: str, label: str, description: str }),
    cohorts: list({
      id: str,
      entityId: str,
      role: { type: 'string', enum: ['actor', 'context'] },
      personaCount: int,
      reason: str,
    }),
    timeline: list({ step: int, label: str, description: str }),
    rounds: int,
    reason: str,
    rules: strList,
    expectedOutputs: strList,
    budget: obj({ simulationAgentCalls: int, cap: int, dropped: strList }),
  },
  required: [],
}
const PERSONAS_SCHEMA = obj({
  personas: list({
    id: str,
    cohortId: str,
    name: str,
    profile: str,
    goals: strList,
    constraints: strList,
    slant: str,
    evidenceRefs: strList,
    relatedIds: strList,
  }),
})

const baseName = (path) => path.split('/').pop()
const json = (value) => JSON.stringify(value)

function extractPrompt(file) {
  const name = baseName(file)
  return [
    'You are extracting entities, relations and claims from one file of a seed pack. They feed an ontology.',
    '',
    `File to read, in full: ${file}`,
    'Write no file. Return the result through the schema.',
    '',
    'Return three lists.',
    '- entities: {id, type, name, summary, source}. An entity is a group of people, a product, a feature, a message, a channel or any other thing the file names. The id uses letters, digits and underscores only (no spaces, slashes or hyphens). Reuse an id the file itself uses, so the same thing gets the same id in every file. The type is a short noun such as Cohort, Product, Feature or Message.',
    '- relations: {from, to, type, status, source}. from and to are entity ids. Put every entity a relation names in your entities list. The type is a short verb phrase such as invites.',
    '- claims: {text, status, source}. The text is one self-contained sentence. When a claim is about an entity, put that entity\'s id in the text.',
    '',
    'status is one of Fact, Assumption, Hypothesis, Unknown. Copy the file\'s own label when it has one. When the file gives no label, use Unknown. Never upgrade a statement to Fact yourself.',
    `source is "${name}:<line>", where <line> is the 1-based line number in the file where the item is stated. Example: ${name}:12.`,
    'Extract only what the file says. Add no outside knowledge.',
    'Do not copy personal details of real people (names, emails, ids, birth dates) into any field. Describe groups of people instead.',
  ].join('\n')
}

function mergePrompt(runDir, extracted) {
  return [
    'You are merging per-file extraction results into one ontology for a seed pack.',
    '',
    `Write the merged ontology to ${runDir}/ontology.json. Write no other file. Return the same content through the schema.`,
    '',
    'Extraction results, one per file. A file whose extractor failed is left out:',
    json(extracted),
    '',
    'Steps:',
    '1. Entities: treat entities with the same id, or clearly the same thing under different ids, as one. Keep one id (prefer the one the pack uses), the fullest summary, and the source of the first file in the list above that names it. Use the kept ids everywhere: rewrite ids in relations and in claim texts.',
    '2. Relations: remove duplicates (same from, to and type). Every from and to must be an id in entities.',
    '3. Claims: remove duplicates (same meaning). When copies disagree on status, keep the least certain one (order: Unknown, Hypothesis, Assumption, Fact), so nothing becomes a Fact that one file doubts. Keep each claim\'s source.',
    '4. entityTypes: one {name, description} for each distinct entity type.',
    '5. Keep status and source values as they are. Add no entity, relation or claim that no extraction result contains.',
    'Entity ids use letters, digits and underscores only.',
  ].join('\n')
}

function planPrompt({ runDir, referencesDir, scenarioFile, ontology }) {
  const scenario = scenarioFile
    ? [`Scenario file, read it in full: ${scenarioFile}`]
    : [
        'No scenario file was found: no file in the pack has "scenario" in its name.',
        'Do not write plan.json. Return only {"error": "<one sentence saying the pack has no scenario file>"}.',
      ]
  return [
    'You are the planner for a swarm simulation. Build the run plan from the scenario and the ontology.',
    '',
    `Write the plan to ${runDir}/plan.json. Return the same content through the schema.`,
    ...scenario,
    '',
    'Read these reference files in full first:',
    `- ${referencesDir}/formats.md (the plan.json format)`,
    `- ${referencesDir}/rules.md (the default rules, and how to merge them with the scenario's rules)`,
    '',
    'Ontology built from the pack:',
    json(ontology),
    '',
    'Plan rules:',
    '1. mode: pick "journey" when the scenario gives a timeline that each actor walks on its own. Pick "social" only when the scenario defines a shared feed, or rounds in which actors see each other\'s posts. Calling the scenario "a social simulation" does not by itself mean "social".',
    '2. variants: list {id, label, description}, one per variant the scenario compares. Include the baseline when the scenario has one. description is the exact text that actors will see for that variant.',
    '3. cohorts: list {id, entityId, role, personaCount, reason}. entityId is the id of an ontology entity, and the cohort id is the same string. role is "actor" when the cohort walks the timeline (or posts, in social mode). role is "context" when the cohort only appears inside actors\' steps, for example a partner whom an actor invites. A context cohort has personaCount 0 and gets no personas. An actor cohort has personaCount of at least 1. Give a reason for each personaCount.',
    '4. Journey mode: timeline is the scenario\'s steps in order, as {step, label, description}, with step counting from 1. Social mode: rounds is a whole number, and reason (top level, next to rounds) says why.',
    '5. rules: follow "Merge with the scenario\'s rules" in rules.md. Put the default rules first, then every item from the scenario\'s "must not produce" and "rules" sections. Each entry is one string.',
    '6. expectedOutputs: the items from the scenario\'s "what the simulation should produce" section, one string each.',
    '7. budget: {simulationAgentCalls, cap, dropped}. cap is 60.',
    '   - Count simulation agent calls with the actor-count formula for the mode, where personas is the sum of personaCount over actor cohorts and variants is the number of variants.',
    '   - Journey: personas × variants.',
    '   - Social: ceil(personas / 4) × rounds × variants.',
    '   - Analyst, report and check agents do not count.',
    '   - simulationAgentCalls must be the result for the final plan and must not exceed 60.',
    '   - When the count is above 60, cut in this order: personaCount (keep at least 1 per actor cohort), then rounds. Do not remove variants. Add one string to dropped for each cut, saying what was cut and why. When nothing is cut, dropped is [].',
    '',
    'Stop and return only {"error": "<one sentence>"}, and write no plan.json, when the scenario is missing or empty, or when you cannot build a plan that meets these rules within the cap.',
  ].join('\n')
}

// A persona's name is a role label built from its cohort id, never a personal name,
// so no persona can carry a real customer's name. Keep in sync with personaName()
// in scripts/swarm-args.mjs.
function personaName(cohortId, n) {
  const words = cohortId
    .replace(/_Representative$/, '')
    .split('_')
    .flatMap((part) => part.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' '))
    .filter(Boolean)
  return `${words.join(' ')} ${n}`
}

function personasPrompt({ runDir, referencesDir, plan, cohort, relations, entity, claims, claimsAreFallback }) {
  const ids = Array.from({ length: cohort.personaCount }, (_, i) => `${cohort.id}-${i + 1}`)
  return [
    'You are writing the personas for one actor cohort of a swarm simulation.',
    '',
    `Cohort: ${cohort.id} (entity ${cohort.entityId}, personaCount ${cohort.personaCount}).`,
    `Write exactly ${cohort.personaCount} personas, with exactly these ids: ${ids.join(', ')}.`,
    `Set each persona's name to exactly its role label: ${ids.map((id, i) => `${id} is "${personaName(cohort.id, i + 1)}"`).join('; ')}. Never use a personal first name or surname anywhere in a persona.`,
    '',
    'Read these reference files in full first:',
    `- ${referencesDir}/personas.md (how to write a persona)`,
    `- ${referencesDir}/formats.md (the persona file format)`,
    '',
    'All cohorts in the plan. Use them to derive related persona ids:',
    json(plan.cohorts),
    '',
    'Ontology relations between cohort entities:',
    json(relations),
    '',
    'This cohort\'s ontology entity:',
    json(entity),
    '',
    claimsAreFallback
      ? 'No claim names this cohort\'s entity, so these are all the ontology claims. Use the ones that fit this cohort:'
      : 'Ontology claims about this cohort\'s entity:',
    json(claims),
    '',
    'Output:',
    `- Write one file per persona to ${runDir}/personas/<id>.json. Create the folder if it is missing. Each file holds one persona object and nothing else. Write no other file.`,
    '- Return {"personas": [...]} through the schema, with the same persona objects that you wrote to the files.',
  ].join('\n')
}

// Returns what is wrong with the plan, or null. The schema cannot require fields, so check here.
function planProblem(plan) {
  if (plan.mode !== 'journey' && plan.mode !== 'social') return 'mode is not journey or social'
  for (const key of ['variants', 'cohorts', 'rules', 'expectedOutputs']) {
    if (!Array.isArray(plan[key])) return `${key} is missing`
  }
  if (plan.variants.length === 0) return 'variants is empty'
  if (plan.mode === 'journey' && !Array.isArray(plan.timeline)) return 'timeline is missing'
  if (plan.mode === 'social' && !Number.isInteger(plan.rounds)) return 'rounds is missing'
  const budget = plan.budget
  if (!budget || typeof budget.simulationAgentCalls !== 'number' || !Array.isArray(budget.dropped)) {
    return 'budget is missing or incomplete'
  }
  return null
}

// Returns why a persona must be dropped, or null when its id and cohortId are right.
function personaProblem(persona, cohort, seen) {
  if (!persona || typeof persona.id !== 'string') return 'it has no id'
  if (persona.cohortId !== cohort.id) return `its cohortId is "${persona.cohortId}", not "${cohort.id}"`
  const prefix = `${cohort.id}-`
  const n = persona.id.startsWith(prefix) ? persona.id.slice(prefix.length) : ''
  if (!/^[1-9]\d*$/.test(n) || Number(n) > cohort.personaCount) {
    return `its id is not ${prefix}<n> with 1 <= n <= ${cohort.personaCount}`
  }
  if (seen.has(persona.id)) return 'its id is a duplicate'
  const expectedName = personaName(cohort.id, Number(n))
  if (persona.name !== expectedName) return `its name is "${persona.name}", not "${expectedName}"`
  return null
}

if (typeof args.runDir !== 'string' || typeof args.referencesDir !== 'string' || !Array.isArray(args.files)) {
  return { error: 'swarm-prepare needs args.runDir, args.referencesDir and args.files' }
}
const runDir = args.runDir.replace(/\/+$/, '')
const referencesDir = args.referencesDir.replace(/\/+$/, '')

// Extract
phase('Extract')
const extractResults = await parallel(
  args.files.map((file) => () =>
    agent(extractPrompt(file), { label: `extract:${baseName(file)}`, model: 'opus', schema: EXTRACT_SCHEMA }),
  ),
)
const extracted = []
let nullExtractors = 0
extractResults.forEach((result, i) => {
  const name = baseName(args.files[i])
  if (!result) {
    nullExtractors++
    log(`extract:${name}: agent returned null, so this file is left out of the ontology`)
  } else {
    extracted.push({ file: name, ...result })
  }
})
if (extracted.length === 0) {
  return { error: 'No extractor returned a result, so there is nothing to merge.' }
}

// Merge
phase('Merge')
const ontology = await agent(mergePrompt(runDir, extracted), {
  label: 'merge',
  model: 'opus',
  schema: MERGE_SCHEMA,
})
if (!ontology) {
  log('merge: agent returned null')
  return { error: 'The merge agent returned null, so there is no ontology.' }
}

// Plan
phase('Plan')
const scenarioFile = args.files.find((file) => baseName(file).toLowerCase().includes('scenario'))
const plan = await agent(planPrompt({ runDir, referencesDir, scenarioFile, ontology }), {
  label: 'plan',
  model: 'opus',
  schema: PLAN_SCHEMA,
})
if (!plan) {
  log('plan: agent returned null')
  return { error: 'The plan agent returned null, so there is no plan.' }
}
if (plan.error) {
  log(`plan: ${plan.error}`)
  return { error: plan.error }
}
const problem = planProblem(plan)
if (problem) {
  log(`plan: invalid plan, ${problem}`)
  return { error: `The plan agent returned an invalid plan: ${problem}.` }
}

// Personas
phase('Personas')
const cohortEntityIds = new Set(plan.cohorts.map((cohort) => cohort.entityId))
const cohortRelations = ontology.relations.filter(
  (relation) => cohortEntityIds.has(relation.from) && cohortEntityIds.has(relation.to),
)
const actorCohorts = plan.cohorts.filter((cohort) => cohort.role === 'actor' && cohort.personaCount > 0)
const personaResults = await parallel(
  actorCohorts.map((cohort) => () => {
    const entity = ontology.entities.find((e) => e.id === cohort.entityId) ?? null
    const needles = [cohort.entityId, entity?.name].filter(Boolean).map((s) => s.toLowerCase())
    const named = ontology.claims.filter((claim) => needles.some((s) => claim.text.toLowerCase().includes(s)))
    const claimsAreFallback = named.length === 0
    return agent(
      personasPrompt({
        runDir,
        referencesDir,
        plan,
        cohort,
        relations: cohortRelations,
        entity,
        claims: claimsAreFallback ? ontology.claims : named,
        claimsAreFallback,
      }),
      { label: `personas:${cohort.id}`, model: 'opus', schema: PERSONAS_SCHEMA },
    )
  }),
)

const personas = []
let nullPersonaAgents = 0
let droppedPersonas = 0
personaResults.forEach((result, i) => {
  const cohort = actorCohorts[i]
  if (!result) {
    nullPersonaAgents++
    log(`personas:${cohort.id}: agent returned null, so this cohort has no personas`)
    return
  }
  const seen = new Set()
  let kept = 0
  for (const persona of Array.isArray(result.personas) ? result.personas : []) {
    const why = personaProblem(persona, cohort, seen)
    if (why) {
      droppedPersonas++
      log(`personas:${cohort.id}: dropped persona "${persona?.id}" because ${why}`)
    } else {
      seen.add(persona.id)
      kept++
      personas.push(persona)
    }
  }
  if (kept < cohort.personaCount) {
    log(`personas:${cohort.id}: kept ${kept} of ${cohort.personaCount} personas`)
  }
})

return {
  mode: plan.mode,
  variants: plan.variants,
  cohorts: plan.cohorts,
  personas: personas.map(({ id, name, slant }) => ({ id, name, slant })),
  plannedSimulationCalls: plan.budget.simulationAgentCalls,
  dropped: plan.budget.dropped,
  problems: { nullExtractors, droppedPersonas, nullPersonaAgents },
}
