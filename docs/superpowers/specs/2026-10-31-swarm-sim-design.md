# swarm-sim design

Date: 2026-10-31
Status: approved in brainstorming; spec review passed after 5 rounds

## Purpose

swarm-sim is a Claude Code project skill that does what MiroFish does: it reads a seed pack, builds an ontology, writes synthetic personas, simulates how those personas react to a scenario, and writes a checked report. It runs on Claude subagents through the Workflow tool instead of a Flask backend, KuzuDB and an external LLM provider.

The first test input is a private sample pack for a consumer mobile app, kept in the git-ignored `analysis/` folder (`packDir`). Background material sits in sibling folders and is not part of the pack. Its scenario asks which of two lead messages (A, B) or the current mixed listing (baseline) should lead the app's US App Store listing.

## Goals

1. Run two simulation modes, chosen per run by the scenario:
   - Journey mode: each persona walks the scenario's timeline on its own and records a decision at each step.
   - Social mode: personas share a feed and post, reply, like or ignore across rounds.
2. Size each run from the task. A planner derives personas per cohort, variants and steps or rounds from the pack, and records the reason for each number.
3. Stop between preparation and simulation so the user can review and edit the plan and personas.
4. Check the report against the scenario's rules and against the simulation logs before the user sees it.
5. Let the user interview a persona from a finished run.

## Non-goals

- Measured conversion rates, predicted percentage changes, price advice or market selection, unless a scenario explicitly asks for them. The sample scenario forbids all four.
- A graph database. The ontology is a JSON file.
- A web UI.
- Matching MiroFish's scale of hundreds of agents per round.

## Architecture

Three units, which communicate only through files in a run folder:

| Unit | File | Job |
|---|---|---|
| Skill | `.claude/skills/swarm-sim/SKILL.md` | Entry point. Routes the commands `/swarm-sim prepare <packDir> <slug>`, `/swarm-sim run <runDir>` and `/swarm-sim interview <runDir> <personaId>`. Builds workflow `args`. Shows the checkpoint summary. |
| Prepare workflow | `.claude/workflows/swarm-prepare.js` | Builds `ontology.json`, `plan.json` and `personas/`. |
| Run workflow | `.claude/workflows/swarm-run.js` | Runs the simulation, analysis, report, check and revision. |

Workflow scripts hold control flow only. They have no filesystem access, so agents do all reading and writing, and any value the script branches on must come back from an agent through a `schema` or arrive in `args`.

The skill builds `args` in the main loop:

- `swarm-prepare`: `{packDir, runDir, files, referencesDir}`. `files` is the list of top-level `*.md` files in `packDir`. The skill excludes the `runs/` folder, so earlier runs are never extracted.
- `swarm-run`: `{packDir, runDir, plan, personaRefs, factsPath, referencesDir}`. The skill reads `plan.json`, every `personas/*.json` file and `ontology.json` from `runDir`. It passes the plan in full. It writes the ontology claims with `status: Fact`, as `{text, source}`, to `<runDir>/facts.json` and passes the absolute path as `factsPath`. It passes personas by reference too: `personaRefs` is `[{id, cohortId, path, relatedIds}]`, with `path` the absolute path of the persona file. The agents read both files, so the main loop never copies persona or fact text into `args`.

Reference material for agents (file formats, persona guidance, default rules) lives in `.claude/skills/swarm-sim/references/`. The skill passes its absolute path as `referencesDir`, because scripts cannot resolve paths.

### Repository layout

```
swarm-sim/
  .claude/skills/swarm-sim/SKILL.md
  .claude/skills/swarm-sim/references/
  .claude/workflows/swarm-prepare.js
  .claude/workflows/swarm-run.js
  tests/
  docs/superpowers/specs/
  README.md
```

The skill and workflows are project-scoped. The user runs them from the swarm-sim repo and passes the pack path.

### Run folder

Runs are written next to the pack, never into the repo, because packs can hold personal customer data.

```
<packDir>/runs/<YYYY-MM-DD>-<slug>/
  ontology.json
  plan.json
  facts.json                           the ontology claims with status Fact, written by the skill before swarm-run
  personas/<personaId>.json
  sim/<variant>/<personaId>.jsonl      journey mode
  sim/<variant>/round-<n>/<batch>.json social mode
  analysis/<variant>.json
  run-result.json                      the swarm-run return value, written by the main loop
  report.md
  check.json
  check-2.json
  check-3.json
  report.final.md
```

The report files are written by the main loop, not by the workflow's agents, because the harness blocks subagents from writing report files. `swarm-args.mjs save` writes them from `run-result.json`.

The skill never overwrites an existing run folder. If the folder exists, it appends `-2`, `-3` and so on.

## Data formats

### ontology.json

- `entityTypes`: list of `{name, description}`.
- `entities`: list of `{id, type, name, summary, source}`.
- `relations`: list of `{from, to, type, status, source}`.
- `claims`: list of `{text, status, source}`.

`status` is one of `Fact`, `Assumption`, `Hypothesis` or `Unknown`, copied from the pack's own labels where they exist. `source` is `file:line`.

### plan.json

- `mode`: `journey` or `social`. The plan agent picks `journey` when the scenario gives a timeline that each actor walks on their own. It picks `social` only when the scenario defines a shared feed or rounds in which actors see each other's posts. Calling the scenario "a social simulation" does not by itself mean `social` mode.
- `variants`: list of `{id, label, description}`. For the sample pack: `A`, `B`, `baseline`.
- `cohorts`: list of `{id, entityId, role, personaCount, reason}`. `role` is `actor` when the cohort walks the timeline (or posts, in social mode), or `context` when it only appears inside actors' steps. In the sample pack, the four user-cohort entities are `actor` cohorts. The invited-helper entities are `context`: the timeline covers only the main user, and that user's invite decision refers to them. `context` cohorts have `personaCount: 0` and get no persona files.
- `timeline` (journey mode): ordered list of `{step, label, description}`.
- `rounds` (social mode): number, with `reason`.
- `rules`: list of rules taken from the scenario's "must not produce" and "rules" sections, plus the default rules in `references/`.
- `expectedOutputs`: list taken from the scenario's "what the simulation should produce" section.
- `budget`: `{simulationAgentCalls, cap, dropped}`. The soft cap is 60 simulation agent calls. `dropped` lists anything cut to stay under the cap, with the reason.

### personas/<personaId>.json

`{id, cohortId, name, profile, goals, constraints, slant, evidenceRefs, relatedIds}`. `id` must be `<cohortId>-<n>` with `n` counting from 1, so parallel cohort agents never write the same file. The personas stage rejects (logs and drops) any persona whose id does not match. `slant` is the angle that makes this persona differ from the others in its cohort. `evidenceRefs` point to ontology claims. `relatedIds` lists the persona ids this persona is related to, through ontology relations between their cohorts. It is used only in social mode and may be empty.

### Journey log line

One JSON object per line: `{step, variant, sees, decision, reason, quote, label}`. `label` is `Fact` when the reason rests on a pack Fact, otherwise `Hypothesis`.

### Social round file

`{round, batch, actions: [{id, personaId, type, targetId, text, label}]}`. `type` is `post`, `reply`, `like` or `ignore`. The script, not the agent, chooses `id` as `r<round>-b<batch>-<i>`, where `i` is the action's index in the agent's returned list. `targetId` is the `id` of an earlier action and is empty for `post`.

## Workflow: swarm-prepare

1. Extract. One agent per file in `args.files` returns entities, relations and claims through a schema, each tagged with status and source. These agents run in parallel.
2. Merge. One agent receives every extractor result in its prompt, removes duplicates across files, writes `ontology.json` and returns it through a schema. This step waits for every extractor, because duplicates span files.
3. Plan. One agent reads the scenario file and the ontology, writes `plan.json` and returns it through a schema. The plan agent enforces the 60-call cap and fills `budget.dropped`. If the pack has no scenario, the plan agent returns `{error}` and the workflow stops.
4. Personas. One agent per `actor` cohort (`personaCount > 0`) in the returned plan writes `personaCount` personas, each with a different slant and with evidence refs, and returns them through a schema. Each persona agent's prompt inlines the full `plan.cohorts` (ids and `personaCount`, so every persona id `<cohortId>-<n>` can be derived) and the ontology relations between cohorts, so it can fill `relatedIds`. These agents run in parallel.
5. Return a summary: mode, variants, cohorts, persona names and slants, planned simulation agent calls and anything dropped.

The skill shows the summary to the user. This is the checkpoint. The user can edit `plan.json` or any persona file, or approve. `swarm-run` starts only after the user approves.

Before starting `swarm-run`, the skill checks `personas/`. It expects exactly the files `<cohortId>-<n>.json` for each `actor` cohort, with `n` from 1 to `personaCount`. A missing file, or any other file in `personas/`, fails the check. The skill names the files and tells the user to re-run `prepare` or fix them. Only the expected files are listed in `args.personaRefs`.

## Workflow: swarm-run

### Journey mode

- The script first asserts that `personas.length × variants.length` is at most `plan.budget.cap`. If not, it stops with an error.
- One actor agent per (persona, variant) pair. For the sample pack with 12 personas and 3 variants, that is 36 agents.
- The actor prompt inlines its own variant's text and the timeline. It names two files, the actor's own persona file (`ref.path`) and `args.factsPath`, and tells the actor to read exactly those and no other file. The actor is told not to read the scenario file, the plan or other personas, so it never sees another variant.
- Each actor walks every timeline step in one context, so later steps remember earlier ones.
- Each actor writes its JSONL log and returns the same lines through a schema.
- The script runs `pipeline(variants, ...)`. Stage 1 runs `parallel()` over that variant's personas. Stage 2 is that variant's analyst (see below). A variant's analyst starts as soon as its own actors finish.

### Social mode

- Each variant runs its own loop of `rounds` rounds, with its own feed state. The script runs `pipeline(variants, ...)`: stage 1 is that variant's round loop, stage 2 is its analyst.
- Batch size is 4. The last batch takes the remainder, so it has 1 to 4 personas. Batches = `ceil(personas.length / 4)`.
- Before any actor runs, the script asserts `batches × rounds × variants.length ≤ plan.budget.cap`. If not, it stops with an error. The plan agent uses the same formula when it sizes the run.
- In every round, the batch prompt includes the variant's text as the stimulus. In round 1 every feed is empty.
- Before each round, the script builds one feed per persona from earlier `post` and `reply` actions. The ranking is plain JavaScript with one sort key, highest first: `score = 2 × related + replies − (currentRound − postRound)`. `related` is 1 if the author is in the persona's `relatedIds`, else 0. `replies` counts actions whose `targetId` is this post. Ties break by action `id`, ascending as a string. Each persona's feed is its top 10 posts.
- The sample scenario is a journey, so the acceptance run uses journey mode. Social mode is covered by harness tests with fixtures only in v1.
- Personas are batched by the rule above (4 each, remainder last). The batch prompt lists each persona in the batch by id and path, and tells the agent to read those persona files and `args.factsPath` only. It inlines each persona's own feed, plus the ids the agent must use for its actions: `r<round>-b<batch>-0`, `-1` and so on, in order. The agent writes its round file with those ids and returns the same actions through a schema. The script checks that the returned ids match the given sequence and logs and drops any action that does not.
- The script keeps feed state in memory between rounds.

### Analysis, report, check (both modes)

1. Analyze. One analyst agent per variant receives that variant's actor results in its prompt and writes `analysis/<variant>.json`: objections, unanswered questions and expectation gaps, each with a citation. Journey citations are `<variant>/<personaId>:<step>`. Social citations are `<variant>/round-<n>/<actionId>`. In social mode the analyst runs after the last round.
2. Report. One agent reads every analysis and returns the report text through a schema (`markdown`). It writes no file. The report covers each of the plan's `expectedOutputs`, and every claim carries at least one citation in the formats above. Hypotheses go in one markdown table:

   | # | If the listing leads with (X) | then this changes (Y) | measured by (Z) | Citations |
   |---|---|---|---|---|

   Each row reads as "If the listing leads with X, then Y changes, measured by Z". X, Y and Z must each be non-empty.
3. Check. One checker agent receives the report text in its prompt and reads `plan.rules` and the logs. It writes no file and returns the check through a schema: `violations` (`{rule, quote, fix}`) and `untraced` (claims whose citation is missing, malformed or points to a log line that does not exist or does not support the claim).
4. Revise. If the first check is clean, the final report is the report text, and this step ends. Otherwise:
   1. One reviser agent receives the report text and the check items in its prompt and returns the revised text through a schema (`markdown`). It writes no file.
   2. A second checker agent receives the revised text in its prompt and returns its check through a schema. It writes no file.
   3. If the second check has items, steps 1 and 2 run once more on the revised text (labels `revise-2` and `check-3`). Revised 2026-10-31, owner decision: one revision did not reliably clear a 30-journey report.
   4. If the last check has items, the script appends them to the final report under a "Known issues" heading: one bullet per violation (`rule: quote → fix`) and one per untraced claim.
   There are at most two revisions.
5. Return the coverage counts, the final check result (the last check that ran) and `files`: the report text as `report.md`, the first check as `check.json`, the final report as `report.final.md`, and the later checks as `check-2.json` and `check-3.json` if they ran. Names are relative to the run folder. A null report or first check, or an empty report text, stops the workflow with an error and the coverage counts. A null or empty revision, or a null re-check, stops it with an error, the coverage counts and `files`, whose `report.final.md` is the last checked text with its Known issues. An unchecked revision is never saved as the final report. The main loop writes `files` into the run folder.

## Interview mode

`/swarm-sim interview <runDir> <personaId>` runs in the main loop with no workflow. The skill loads the persona file and that persona's log lines, then answers the user's questions in character. Anything the persona says that is not in its profile or logs is labeled as a hypothesis.

## Models

Every agent call sets its model explicitly. Only the simulation actors use sonnet; every other stage uses opus.

| Stage | Model |
|---|---|
| Plan (orchestration: mode, sizing, rules) | opus |
| Report, check, revise, check-2, revise-2, check-3 | opus |
| Extract, merge, personas, analysts | opus |
| Simulation actors (journey actors, social batches) | sonnet |

The main loop that runs the skill is the orchestrator and uses the session model.

## Error handling

- An agent that returns null is logged with `log()`. The report states coverage, for example "34 of 36 pairs completed". Nothing is dropped silently.
- Missing `plan.json` at `run` time: the skill stops and says which file is missing.
- A pack with no scenario: `swarm-prepare` stops after the plan step and the skill asks the user for a scenario.
- An interrupted workflow resumes with `resumeFromRunId` and the same `args`, so it keeps its run folder. Only a fresh `prepare` creates a new run folder.

## Testing

### Harness tests (`tests/`, run with `node --test`)

A harness loads each workflow script, removes the `export` keyword from `meta`, and runs the body with fake `agent`, `parallel`, `pipeline`, `phase`, `log` and `args`. The fake `agent` returns fixture outputs keyed by label. The tests assert:

1. The number of actor calls is `personas × variants` in journey mode and `ceil(personas / 4) × rounds × variants` in social mode, and the total agent calls match those plus the fixed stages.
2. Both modes stop before any actor runs when their actor count exceeds `plan.budget.cap`.
3. Every journey actor prompt contains exactly one variant's text.
4. A null agent result is logged and counted in coverage.
5. Feed ranking matches the score formula and tie-break on a fixture.
6. `meta.phases` titles match the `phase()` calls.
7. The reviser runs only when the first check has items, and a second time only when check-2 has items.
8. Every `agent()` call sets `model`.

### Acceptance run (sample pack)

Run `prepare`, approve, then `run`, on the sample pack in `analysis/`. Pass criteria:

1. `plan.json` has `mode: journey` and variants `A`, `B` and `baseline`.
2. For each of Message A and Message B, `report.final.md` lists at least one objection from each `actor` cohort, each citing a log line.
3. For each message, at least one unanswered question, citing a log line.
4. For each message, at least one expectation the first week does not meet, citing a log line.
5. The hypothesis table has at least 3 rows, and every row has non-empty X, Y, Z and Citations cells.
6. The final check (`check-3.json`, else `check-2.json`, else `check.json`) has 0 `violations` and 0 `untraced`.
7. The report has no conversion rates or predicted percentages, no price recommendations, no market or country selection, and no statements about real customers' preferences. Pass test: criterion 6 holds, and `grep -nE '[0-9]+(\.[0-9]+)? ?%' report.final.md` returns nothing. Naming a metric such as "product page conversion rate" in a Z cell is allowed; stating or predicting its value is not, and the checker enforces that through `plan.rules`.
8. Every speculative reason is labeled as a hypothesis, and no competitor feature beyond price is stated as fact. Pass test: `plan.rules` contains the scenario's hypothesis-labeling rule and its competitor-feature rule (assert on `plan.json`), and criterion 6 holds.

## Open items

- None.
