export const meta = {
  name: 'swarm-run',
  description: 'Simulates each persona against each variant, analyzes the logs, then writes, checks and revises the report.',
  phases: [{ title: 'Simulate' }, { title: 'Analyze' }, { title: 'Report' }, { title: 'Check' }],
}

/*
 * swarm-run: simulates each persona against each variant, analyzes the logs, then writes, checks and revises the report.
 * The script holds control flow only. Actors and analysts write their own files, so personas and facts go in by reference.
 * The report, check and revise agents write no file: the harness blocks subagents from writing report files, so they
 * return text, and the script returns it to the caller as `files` for the main loop to write.
 *
 * args:
 *   packDir        absolute path of the seed pack.
 *   runDir         absolute path of the run folder.
 *   plan           the parsed plan.json.
 *   personaRefs    [{id, cohortId, path, relatedIds}], one per persona, in plan order. `path` is the absolute
 *                  path of the persona file, which the persona's agent reads. `relatedIds` is optional and
 *                  only ranks social feeds.
 *   factsPath      absolute path of <runDir>/facts.json: the pack Facts as [{text, source}].
 *   referencesDir  absolute path of .claude/skills/swarm-sim/references/ in the swarm-sim repo.
 *
 * Returns {error} when it stops early (including bad args, before any agent runs), else
 * {coverage, files, finalCheck}. `files` maps names relative to runDir to content: "report.md", "check.json" and
 * "report.final.md", plus "check-2.json" and "check-3.json" for each revision that was checked.
 */

const { plan, personaRefs, factsPath, referencesDir } = args
const runDir = args.runDir.replace(/\/+$/, '')

const isPersonaRef = (ref) =>
  ref !== null && typeof ref === 'object' && ['id', 'cohortId', 'path'].every((key) => typeof ref[key] === 'string')

if (!Array.isArray(personaRefs) || !personaRefs.every(isPersonaRef)) {
  return { error: 'args.personaRefs must be an array of {id, cohortId, path}' }
}
if (typeof factsPath !== 'string') return { error: 'args.factsPath must be a string' }

// Schemas (agent results come back through these; the script never reads files).
const TEXT = { type: 'string' }

const ACTOR_SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          step: { type: 'number' },
          variant: TEXT,
          sees: TEXT,
          decision: TEXT,
          reason: TEXT,
          quote: TEXT,
          label: { type: 'string', enum: ['Fact', 'Hypothesis'] },
        },
        required: ['step', 'variant', 'sees', 'decision', 'reason', 'quote', 'label'],
      },
    },
  },
  required: ['lines'],
}

const ACTION_TYPES = ['post', 'reply', 'like', 'ignore']

const SOCIAL_SCHEMA = {
  type: 'object',
  properties: {
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: TEXT,
          personaId: TEXT,
          type: { type: 'string', enum: ACTION_TYPES },
          targetId: TEXT,
          text: TEXT,
          label: { type: 'string', enum: ['Fact', 'Hypothesis'] },
        },
        required: ['id', 'personaId', 'type', 'targetId', 'text', 'label'],
      },
    },
  },
  required: ['actions'],
}

const FINDINGS = {
  type: 'array',
  items: {
    type: 'object',
    properties: { text: TEXT, cohortId: TEXT, citation: TEXT },
    required: ['text', 'cohortId', 'citation'],
  },
}

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: { objections: FINDINGS, unansweredQuestions: FINDINGS, expectationGaps: FINDINGS },
  required: ['objections', 'unansweredQuestions', 'expectationGaps'],
}

const MARKDOWN_SCHEMA = {
  type: 'object',
  properties: { markdown: TEXT },
  required: ['markdown'],
}

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    violations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { rule: TEXT, quote: TEXT, fix: TEXT },
        required: ['rule', 'quote', 'fix'],
      },
    },
    untraced: { type: 'array', items: TEXT },
  },
  required: ['violations', 'untraced'],
}

const HYPOTHESIS_TABLE_HEADER = [
  '| # | If the listing leads with (X) | then this changes (Y) | measured by (Z) | Citations |',
  '|---|---|---|---|---|',
].join('\n')

const json = (value) => JSON.stringify(value, null, 2)

const numbered = (items) => items.map((item, i) => `${i + 1}. ${item}`).join('\n')

const FACTS_FILE_NOTE = 'a JSON list of {text, source}. These are the only things you may state about the product as fact.'

/** Returns an error message when `count` simulation calls exceed the cap, else null. */
function capError(count, cap, formula) {
  if (typeof cap !== 'number' || !Number.isFinite(cap)) return 'plan.budget.cap is missing or not a number'
  if (count > cap) return `${formula} = ${count}, which exceeds plan.budget.cap of ${cap}`
  return null
}

// What the analyst looks for, in both modes.
const FINDING_KINDS = [
  '- objections: reasons a persona resists or rejects the variant.',
  '- unansweredQuestions: questions a persona has that the variant does not answer.',
  '- expectationGaps: expectations a persona has that the product, as shown, does not meet.',
]

/**
 * Maps each variant id to its analysis (null when it has none), logging each null. Returns
 * {analyses, coverage}, or {error, coverage} when no variant has an analysis.
 */
function collectAnalyses(variants, analysisList, coverage, noInputReason) {
  const analyses = {}
  variants.forEach((variant, i) => {
    const analysis = analysisList[i] || null
    analyses[variant.id] = analysis
    if (analysis === null) {
      log(`no analysis for variant ${variant.id}: analyst:${variant.id} returned null or ${noInputReason}`)
    }
  })
  if (Object.values(analyses).every((analysis) => analysis === null)) {
    return { error: `no analysis was produced for any variant (${coverage})`, coverage }
  }
  return { analyses, coverage }
}

// ---------------------------------------------------------------------------
// Journey mode
// ---------------------------------------------------------------------------

function actorPrompt(ref, variant) {
  return [
    'You are acting out one synthetic persona as it walks through a timeline. The persona is a made-up representative of a customer group, not a real customer.',
    '',
    'Files to read. Read exactly these two files and no other file:',
    `- Your persona: ${ref.path}`,
    `- The pack Facts: ${factsPath}, ${FACTS_FILE_NOTE}`,
    '',
    'What this persona is shown:',
    json({ id: variant.id, label: variant.label, description: variant.description }),
    '',
    'Timeline (walk every step, in this order):',
    json(plan.timeline),
    '',
    'How to act:',
    '- Stay in character. At each step decide what the persona sees, what it does and why.',
    '- Walk all the steps in order, in this one session. Later steps must remember what you decided in earlier ones.',
    '- Work from this prompt and the two files above only. Do not read the scenario file, plan.json, or any other persona file.',
    '- Mark a reason as "Fact" only when it rests on one of the Facts in the Facts file. Mark every other reason as "Hypothesis".',
    '',
    'Output:',
    `Write ${runDir}/sim/${variant.id}/${ref.id}.jsonl, creating folders as needed. Write one JSON object per line, one line per timeline step, in step order, with no line breaks inside an object:`,
    `{"step": <the timeline step number>, "variant": "${variant.id}", "sees": "<what the persona sees>", "decision": "<what the persona does>", "reason": "<why>", "quote": "<one sentence in the persona's own voice>", "label": "Fact" or "Hypothesis"}`,
    'Then return the same lines as {lines: [...]}.',
  ].join('\n')
}

function analystPrompt(variant, logs) {
  return [
    `You are the analyst for one variant of a swarm-sim run: "${variant.id}".`,
    '',
    'Variant:',
    json({ id: variant.id, label: variant.label, description: variant.description }),
    '',
    'Simulation logs for this variant, keyed by persona id. Each entry has the persona\'s cohortId and one log line per timeline step. Only actors that completed are included. Use only these logs.',
    json(logs),
    '',
    'Find three kinds of findings:',
    ...FINDING_KINDS,
    '',
    'Rules for every item:',
    '- An item is {text, cohortId, citation}. cohortId is the cohortId of the cited persona.',
    `- It has exactly one citation, in the format ${variant.id}/<personaId>:<step>. The cited line must exist in the logs above and must support the item.`,
    '- Cover each cohort in the logs wherever its lines support a finding. Do not invent findings.',
    '- Keep the log line\'s label. When the cited line is labeled Hypothesis, word the item as a hypothesis (for example "Hypothesis: ...").',
    '',
    `Write {objections, unansweredQuestions, expectationGaps} as JSON to ${runDir}/analysis/${variant.id}.json, creating folders as needed. Then return the same object.`,
  ].join('\n')
}

async function runJourney() {
  const variants = plan.variants
  const total = personaRefs.length * variants.length
  const cap = plan.budget && plan.budget.cap
  const tooBig = capError(total, cap, `${personaRefs.length} personas x ${variants.length} variants`)
  if (tooBig) return { error: tooBig }

  phase('Simulate')

  let completed = 0
  const analysisList = await pipeline(
    variants,
    async (variant) => {
      const results = await parallel(
        personaRefs.map((ref) => () =>
          agent(actorPrompt(ref, variant), {
            label: `actor:${variant.id}/${ref.id}`,
            model: 'sonnet',
            schema: ACTOR_SCHEMA,
            phase: 'Simulate',
          }),
        ),
      )
      const logs = {}
      results.forEach((result, i) => {
        const ref = personaRefs[i]
        if (result === null || result === undefined) {
          log(`actor returned null: actor:${variant.id}/${ref.id}`)
          return
        }
        completed++
        logs[ref.id] = { cohortId: ref.cohortId, lines: result.lines }
      })
      return logs
    },
    async (logs, variant) => {
      if (Object.keys(logs).length === 0) return null
      return agent(analystPrompt(variant, logs), {
        label: `analyst:${variant.id}`,
        model: 'opus',
        schema: ANALYSIS_SCHEMA,
        phase: 'Analyze',
      })
    },
  )

  const coverage = `${completed} of ${total} pairs completed`
  return collectAnalyses(variants, analysisList, coverage, 'had no completed actors')
}

// ---------------------------------------------------------------------------
// Social mode
// ---------------------------------------------------------------------------

const SOCIAL_BATCH_SIZE = 4
const SOCIAL_MAX_ACTIONS_PER_PERSONA = 4
const SOCIAL_FEED_SIZE = 10
const EMPTY_FEED = '(empty: nothing has been posted yet)'

/**
 * Ranks the posts and replies in `actions` for one persona, best first, and keeps the top
 * SOCIAL_FEED_SIZE. score = 2 x related + replies - (currentRound - postRound), where `related`
 * is 1 when the author is in persona.relatedIds, `replies` counts every action whose targetId is
 * this action's id (a like counts as well, as the spec's formula counts any action aimed at the
 * post), and postRound is the action's `round`. Ties break by id, ascending as a plain string.
 * The persona's own posts are not excluded: the spec does not exclude them, and they let the
 * persona see the replies to its own posts.
 */
function rankFeed(actions, persona, currentRound) {
  const related = new Set(persona.relatedIds || [])
  const replies = new Map()
  for (const action of actions) {
    if (action.targetId) replies.set(action.targetId, (replies.get(action.targetId) || 0) + 1)
  }
  return actions
    .filter((action) => action.type === 'post' || action.type === 'reply')
    .map((action) => ({
      action,
      score: 2 * (related.has(action.personaId) ? 1 : 0) + (replies.get(action.id) || 0) - (currentRound - action.round),
    }))
    .sort((a, b) => b.score - a.score || (a.action.id < b.action.id ? -1 : a.action.id > b.action.id ? 1 : 0))
    .slice(0, SOCIAL_FEED_SIZE)
    .map((entry) => entry.action)
}

const feedItem = (a) => ({ id: a.id, personaId: a.personaId, type: a.type, targetId: a.targetId, text: a.text, round: a.round })

const actionIds = (round, batchIndex, count) => Array.from({ length: count }, (_, i) => `r${round}-b${batchIndex}-${i}`)

function socialPrompt(variant, batch, batchIndex, round, feeds, ids) {
  return [
    'You are acting out a batch of synthetic personas in one round of a shared social feed. The personas are made-up representatives of customer groups, not real customers.',
    '',
    'What every persona in this batch is shown (the stimulus):',
    json({ id: variant.id, label: variant.label, description: variant.description }),
    '',
    `This is round ${round} of ${plan.rounds}, batch ${batchIndex}.`,
    '',
    'Files to read. Read exactly these files and no other file:',
    `- The pack Facts: ${factsPath}, ${FACTS_FILE_NOTE}`,
    '- The persona files of this batch, one per persona:',
    ...batch.map((ref) => `  - ${ref.id}: ${ref.path}`),
    '',
    'Personas in this batch. Each is followed by the feed that persona sees this round, best item first:',
    '',
    ...batch.flatMap((ref, i) => [
      `Persona ${i + 1} of ${batch.length}: ${ref.id}`,
      `Feed for ${ref.id}:`,
      feeds[i].length === 0 ? EMPTY_FEED : json(feeds[i].map(feedItem)),
      '',
    ]),
    'How to act:',
    '- Stay in character. A persona reacts to what is in its own feed and to the stimulus. Posting something new is always allowed.',
    `- Each persona may take up to ${SOCIAL_MAX_ACTIONS_PER_PERSONA} actions this round, or none. An action is one of:`,
    '  - post: a new post. Set targetId to "".',
    '  - reply: an answer to an item. Set targetId to the id of an item in that persona\'s feed, or of an earlier action in your own list for this batch.',
    '  - like: a like of an item. Set targetId the same way as for a reply.',
    '  - ignore: the persona scrolls past. Set targetId to "".',
    '- You cannot see what the other batches do this round. Do not invent items that are not in a feed or in your own list.',
    '- Work from this prompt and the files above only. Do not read the scenario file, plan.json, or any other persona file.',
    '- Mark an action as "Fact" only when its text rests on one of the Facts in the Facts file. Mark every other action as "Hypothesis".',
    '',
    'Action ids:',
    `Give your actions these ids, in this order, without skipping any: ${ids.join(', ')}.`,
    'The first action you return gets the first id, the second gets the second, and so on. Use only as many ids as you need, starting from the first. Do not choose ids of your own.',
    '',
    'Output:',
    `Write ${runDir}/sim/${variant.id}/round-${round}/b${batchIndex}.json, creating folders as needed, as JSON in this shape:`,
    `{"round": ${round}, "batch": ${batchIndex}, "actions": [{"id": "<given id>", "personaId": "<a persona in this batch>", "type": "post" | "reply" | "like" | "ignore", "targetId": "<id, or empty>", "text": "<what the persona writes, or why it ignores>", "label": "Fact" or "Hypothesis"}]}`,
    'Then return the same actions as {actions: [...]}.',
  ].join('\n')
}

function socialAnalystPrompt(variant, actions) {
  const cohortIds = {}
  personaRefs.forEach((ref) => {
    cohortIds[ref.id] = ref.cohortId
  })
  return [
    `You are the analyst for one variant of a swarm-sim run: "${variant.id}".`,
    '',
    'Variant:',
    json({ id: variant.id, label: variant.label, description: variant.description }),
    '',
    'Every action the personas took under this variant, in order. Each has the round it was taken in. Use only these actions.',
    json(actions),
    '',
    'Persona id to cohortId:',
    json(cohortIds),
    '',
    'Find three kinds of findings:',
    ...FINDING_KINDS,
    '',
    'Rules for every item:',
    '- An item is {text, cohortId, citation}. cohortId is the cohortId of the persona who took the cited action.',
    `- It has exactly one citation, in the format ${variant.id}/round-<n>/<actionId>, where <n> is the round of the cited action. The cited action must exist in the list above and must support the item.`,
    '- Cover each cohort in the actions wherever they support a finding. Do not invent findings.',
    '- Keep the action\'s label. When the cited action is labeled Hypothesis, word the item as a hypothesis (for example "Hypothesis: ...").',
    '',
    `Write {objections, unansweredQuestions, expectationGaps} as JSON to ${runDir}/analysis/${variant.id}.json, creating folders as needed. Then return the same object.`,
  ].join('\n')
}

/** Returns why the batch's action at `index` is invalid, or null when it is kept. `known` holds the ids it may target. */
function actionProblem(action, index, ids, batch, known) {
  if (ids[index] === undefined) return `id "${action.id}" has no given id to match: the batch allows only ${ids.length} actions`
  if (action.id !== ids[index]) return `id "${action.id}" is not the given id "${ids[index]}"`
  if (!batch.some((persona) => persona.id === action.personaId)) return `personaId "${action.personaId}" is not in this batch`
  if (!ACTION_TYPES.includes(action.type)) return `type "${action.type}" is not one of ${ACTION_TYPES.join(', ')}`
  if (action.type === 'post' && action.targetId) return `post has targetId "${action.targetId}" but must have none`
  if ((action.type === 'reply' || action.type === 'like') && !known.has(action.targetId)) {
    return `${action.type} targets "${action.targetId}", which is not an earlier action`
  }
  return null
}

async function runSocial() {
  const variants = plan.variants
  const rounds = plan.rounds
  if (!Number.isInteger(rounds) || rounds < 1) return { error: 'plan.rounds is missing or not a positive integer' }

  const batches = []
  for (let i = 0; i < personaRefs.length; i += SOCIAL_BATCH_SIZE) batches.push(personaRefs.slice(i, i + SOCIAL_BATCH_SIZE))
  const total = batches.length * rounds * variants.length
  const cap = plan.budget && plan.budget.cap
  const tooBig = capError(total, cap, `${batches.length} batches x ${rounds} rounds x ${variants.length} variants`)
  if (tooBig) return { error: tooBig }

  phase('Simulate')

  let completed = 0
  const analysisList = await pipeline(
    variants,
    async (variant) => {
      const actions = []
      for (let round = 1; round <= rounds; round++) {
        // Every prompt of the round is built before any batch runs, so no batch sees this round's
        // actions, and a reply or like may only target an action from an earlier round or an
        // earlier kept action of its own batch.
        const earlierIds = new Set(actions.map((action) => action.id))
        const calls = batches.map((batch, k) => {
          const ids = actionIds(round, k, batch.length * SOCIAL_MAX_ACTIONS_PER_PERSONA)
          const feeds = batch.map((persona) => rankFeed(actions, persona, round))
          return { batch, k, ids, label: `social:${variant.id}/r${round}/b${k}`, prompt: socialPrompt(variant, batch, k, round, feeds, ids) }
        })
        const results = await parallel(
          calls.map((call) => () =>
            agent(call.prompt, { label: call.label, model: 'sonnet', schema: SOCIAL_SCHEMA, phase: 'Simulate' }),
          ),
        )
        results.forEach((result, i) => {
          const { batch, ids, label } = calls[i]
          if (result === null || result === undefined) {
            log(`social batch returned null: ${label}`)
            return
          }
          completed++
          const known = new Set(earlierIds)
          result.actions.forEach((action, index) => {
            const problem = actionProblem(action, index, ids, batch, known)
            if (problem) {
              log(`dropped action ${index} of ${label}: ${problem}`)
              return
            }
            known.add(action.id)
            actions.push({
              round,
              id: action.id,
              personaId: action.personaId,
              type: action.type,
              targetId: action.targetId || '',
              text: action.text,
              label: action.label,
            })
          })
        })
      }
      return actions
    },
    async (actions, variant) => {
      if (actions.length === 0) return null
      return agent(socialAnalystPrompt(variant, actions), {
        label: `analyst:${variant.id}`,
        model: 'opus',
        schema: ANALYSIS_SCHEMA,
        phase: 'Analyze',
      })
    },
  )

  const coverage = `${completed} of ${total} batch rounds completed`
  return collectAnalyses(variants, analysisList, coverage, 'had no valid actions')
}

// ---------------------------------------------------------------------------
// Shared tail: report, check, revise (both modes)
// ---------------------------------------------------------------------------

const NO_FILE = 'Do not write any file.'

/** Variant wording comes from the plan, not from a log line, so it gets its own citation. */
const variantCitationLines = () => [
  '- Variant wording: variant:<id>. It points to that variant\'s description in the variants below. Use it only for text that restates a variant description; it supports nothing a persona said or did.',
  'Variants:',
  json(plan.variants),
]

/** The text of a report inline in a prompt, between marker lines. */
const reportBlock = (markdown) => ['--- REPORT START ---', markdown, '--- REPORT END ---']

function reportPrompt(analyses, coverage) {
  const missing = Object.keys(analyses).filter((id) => analyses[id] === null)
  const social = plan.mode === 'social'
  const citationFormat = social ? '<variant>/round-<n>/<actionId>' : '<variant>/<personaId>:<step>'
  const unit = social ? { one: 'batch round', many: 'batch rounds' } : { one: 'pair', many: 'pairs' }
  return [
    `You are writing the report of a swarm-sim run. ${NO_FILE} Return the full report as \`markdown\`.`,
    '',
    `First read ${referencesDir}/formats.md (file formats, citation formats and the hypothesis table) and ${referencesDir}/rules.md (the default rules).`,
    '',
    'Variants:',
    json(plan.variants),
    '',
    'Analyses, keyed by variant id (each finding has text, cohortId and a citation):',
    json(analyses),
    ...(missing.length > 0
      ? ['', `No analysis exists for variant(s): ${missing.join(', ')}. Say so in the report and make no claims about them.`]
      : []),
    '',
    'Expected outputs. Give each one its own section, headed with its text:',
    numbered(plan.expectedOutputs),
    '',
    `Coverage: ${coverage}. Put the line "Coverage: ${coverage}" near the top of the report. If not every ${unit.one} completed, say that findings rest on the completed ${unit.many} only.`,
    '',
    'Rules the report must follow (a checker tests the report against each one):',
    numbered(plan.rules),
    '',
    'How to write it:',
    `- Every claim ends with at least one citation in the format ${citationFormat}. Take citations from the analyses. When you restate what a variant shows, cite variant:<id> instead of a log line, because the logs do not describe the variants. You may read the logs under ${runDir}/sim/ to confirm a line exists and supports the claim. Never cite a line you have not confirmed.`,
    '- A claim with a log-line citation says only what that line says. Do not add details from other lines or from the variant descriptions; restate a variant description as its own claim cited variant:<id>.',
    '- Keep the analyses\' wording about hypotheses. Never upgrade a hypothesis to a fact.',
    '- Put all hypotheses in one markdown table with exactly this header:',
    HYPOTHESIS_TABLE_HEADER,
    '  Each row reads as "If the listing leads with X, then Y changes, measured by Z". X, Y, Z and Citations must each be non-empty. Z may name a metric. Z must not state or predict its value.',
    '',
    `${NO_FILE} Return {markdown}: the full report, and nothing else.`,
  ].join('\n')
}

function checkInstructions(reportMarkdown, coverage) {
  return [
    'The report to check is between the REPORT START and REPORT END lines:',
    ...reportBlock(reportMarkdown),
    '',
    'Rules (plan.rules):',
    numbered(plan.rules),
    '',
    'Citation formats. A citation points to one log line:',
    `- Journey mode: <variant>/<personaId>:<step>. It points to the line with that step in ${runDir}/sim/<variant>/<personaId>.jsonl.`,
    `- Social mode: <variant>/round-<n>/<actionId>. It points to the action with that id in the round files under ${runDir}/sim/<variant>/round-<n>/.`,
    ...variantCitationLines(),
    `You may read the simulation logs under ${runDir}/sim/ to verify citations.`,
    '',
    'Find two kinds of problems:',
    '- violations: places where the report breaks a rule above. Each is {rule, quote, fix}: rule is the rule text, quote is the offending text copied from the report, fix is the change that would resolve it. Also report a hypothesis table row with an empty X, Y, Z or Citations cell as a violation, with the rule "Hypothesis table cells X, Y, Z and Citations must be non-empty".',
    '- untraced: claims whose citation is missing, malformed, points to a log line that does not exist, or points to a line that does not support the claim. Each entry is the claim text.',
    `The line "Coverage: ${coverage}" comes from the workflow. It is not a claim and needs no citation.`,
    '',
    `${NO_FILE} Return {violations, untraced}. A clean report has two empty lists.`,
  ]
}

function checkPrompt(reportMarkdown, coverage) {
  return ['You are the checker of a swarm-sim report.', '', ...checkInstructions(reportMarkdown, coverage)].join('\n')
}

function revisePrompt(reportMarkdown, check) {
  return [
    `You are revising a swarm-sim report after a check found problems. ${NO_FILE}`,
    '',
    'The report is between the REPORT START and REPORT END lines:',
    ...reportBlock(reportMarkdown),
    '',
    'Problems the checker found:',
    json(check),
    '',
    `Read the simulation logs under ${runDir}/sim/ to verify citations.`,
    '',
    'Fix each problem:',
    '- For each violation, apply its fix.',
    '- For each untraced claim, give it a citation to a log line that exists and supports it, or remove the claim.',
    '- Citation formats: a log line, or for text that restates a variant description:',
    ...variantCitationLines(),
    '- Then check every other citation in the report, not only the flagged ones: open the cited log line and confirm it exists and supports the claim exactly as worded. Fix the citation or the wording, or remove the claim, when it does not. The first check can miss problems, and a second check follows.',
    '- A claim with a log-line citation says only what that line says. Do not add details from other lines or from the variant descriptions; restate a variant description as its own claim cited variant:<id>.',
    '- Do not add new claims. Keep the structure, the "Coverage:" line and the hypothesis table.',
    '',
    `${NO_FILE} Return the full revised report as \`markdown\`.`,
  ].join('\n')
}

function check2Prompt(revisedMarkdown, coverage) {
  return [
    'You are the second checker of a swarm-sim report. The report was revised after a first check.',
    '',
    ...checkInstructions(revisedMarkdown, coverage),
  ].join('\n')
}

const hasItems = (check) => check.violations.length > 0 || check.untraced.length > 0

const hasMarkdown = (result) => typeof result?.markdown === 'string' && result.markdown.trim() !== ''

/** The "## Known issues" section the script appends to a report whose last check still has items. */
function knownIssues(check) {
  const bullets = [
    ...check.violations.map((violation) => `- ${violation.rule}: ${violation.quote} → ${violation.fix}`),
    ...check.untraced.map((claim) => `- ${claim}`),
  ]
  return ['## Known issues', '', ...bullets].join('\n')
}

const MAX_REVISIONS = 2

/** The final report text: the markdown, plus a Known issues section when the last check has items. */
const withKnownIssues = (markdown, check) => (hasItems(check) ? `${markdown.trimEnd()}\n\n${knownIssues(check)}\n` : markdown)

/** Files in the order the run folder lists them: report, first check, final report, later checks. */
function orderFiles(files) {
  const { 'report.md': reportMd, 'check.json': checkJson, 'report.final.md': finalMd, ...laterChecks } = files
  return { 'report.md': reportMd, 'check.json': checkJson, 'report.final.md': finalMd, ...laterChecks }
}

async function runTail(analyses, coverage) {
  phase('Report')
  const report = await agent(reportPrompt(analyses, coverage), {
    label: 'report',
    model: 'opus',
    schema: MARKDOWN_SCHEMA,
  })
  if (!hasMarkdown(report)) return { error: 'report returned null or no markdown text; no report was produced', coverage }

  phase('Check')
  const check = await agent(checkPrompt(report.markdown, coverage), {
    label: 'check',
    model: 'opus',
    schema: CHECK_SCHEMA,
  })
  if (!check) return { error: 'check returned null; the report was not checked', coverage }
  if (!hasItems(check)) {
    const files = { 'report.md': report.markdown, 'check.json': check, 'report.final.md': report.markdown }
    return { coverage, files, finalCheck: check }
  }

  // Revise and re-check until a check is clean, at most MAX_REVISIONS times. Revision n is
  // labelled revise (n = 1) or revise-<n>, and the check after it check-<n + 1>.
  const files = { 'report.md': report.markdown, 'check.json': check }
  let markdown = report.markdown
  let lastCheck = check
  // On a failed revision or re-check, stop with the last checked text and its Known issues: an unchecked
  // revision is never saved as the final report.
  const stop = (error) => ({ error, coverage, files: orderFiles({ ...files, 'report.final.md': withKnownIssues(markdown, lastCheck) }) })
  for (let n = 1; n <= MAX_REVISIONS && hasItems(lastCheck); n++) {
    const reviseLabel = n === 1 ? 'revise' : `revise-${n}`
    const checkLabel = `check-${n + 1}`
    const revised = await agent(revisePrompt(markdown, lastCheck), {
      label: reviseLabel,
      model: 'opus',
      schema: MARKDOWN_SCHEMA,
    })
    if (!hasMarkdown(revised)) return stop(`${reviseLabel} returned null or no markdown text; the report was not revised`)
    const nextCheck = await agent(check2Prompt(revised.markdown, coverage), {
      label: checkLabel,
      model: 'opus',
      schema: CHECK_SCHEMA,
    })
    if (!nextCheck) return stop(`${checkLabel} returned null; the revision was not re-checked, so the last checked report is kept`)
    markdown = revised.markdown
    files[`${checkLabel}.json`] = nextCheck
    lastCheck = nextCheck
  }
  files['report.final.md'] = withKnownIssues(markdown, lastCheck)
  return { coverage, files: orderFiles(files), finalCheck: lastCheck }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

let simulation
if (plan.mode === 'journey') simulation = await runJourney()
else if (plan.mode === 'social') simulation = await runSocial()
else return { error: `unknown plan.mode: ${plan.mode}` }

if (simulation.error) return simulation
return await runTail(simulation.analyses, simulation.coverage)
