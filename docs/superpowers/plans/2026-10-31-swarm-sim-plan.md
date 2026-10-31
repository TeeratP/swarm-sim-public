# swarm-sim implementation plan

Date: 2026-10-31
Spec: `docs/superpowers/specs/2026-10-31-swarm-sim-design.md`
Status: draft, awaiting approval

## How to use this plan

Each task lists its files, its steps as `step → verify: check`, and its done condition. Tasks run in the order shown, except where "Parallel with" says otherwise. Each task is one GitHub issue (sub-issue of one epic) and one branch, built in `.worktrees/<branch>` from the batch integration branch `changes-YYYYMMDD`.

Model tiers follow the global rules: sonnet at `xhigh` effort writes code from this plan; opus reviews.

## Conventions for every task

- Workflow scripts are plain JavaScript. No TypeScript, no `Date.now()`, `Math.random()` or argless `new Date()`, no filesystem or Node APIs.
- `meta` is a pure literal. `meta.name` equals the file's base name (`swarm-prepare`, `swarm-run`), so the skill can call `Workflow({name})`.
- Every `agent()` call sets `model` (`opus` for plan and report, `sonnet` for everything else) and a stable `label`.
- Tests use `node --test` with no dependencies. Test files must be named `*.test.js`; helpers such as `harness.js` are not run as tests.
- Agent prompts tell agents where to write files under `args.runDir`. Scripts never assume a file was written; they use the value returned through `schema`.

## Task 1: Scaffold the repo

Files: `package.json`, `.gitignore`, `README.md`, `.claude/workflows/`, `.claude/skills/swarm-sim/references/`, `tests/`.

1. Add `package.json` with `"type": "module"` and `"scripts": {"test": "node --test \"tests/**/*.test.js\""}` (Node 24 rejects a bare directory argument) → verify: `npm test` exits 0 with no tests.
2. Add `.gitignore` with `runs/`, `node_modules/` and `.worktrees/` → verify: `git check-ignore runs/x` prints the path.
3. Add `README.md`: what swarm-sim is, the three commands, the data-safety rule from `CLAUDE.md` → verify: read through.

Done: commit on the task branch; `npm test` passes.

Model: sonnet. Size: about 10 minutes.

## Task 2: Test harness

Files: `tests/harness.js`, `tests/harness.test.js`, `tests/fixtures/`.

The harness runs a workflow script against fakes and records every call.

1. `loadWorkflow(path)` reads the script, extracts `meta` (the object literal after `export const meta =`), removes the `export` keyword, and wraps the body in an `AsyncFunction` with parameters `agent, parallel, pipeline, phase, log, args, budget, workflow` → verify: a tiny sample script runs and returns its value.
2. `fakeAgent(responder)` records `{prompt, opts}` for each call and returns `responder(prompt, opts)`. `responder` looks up fixtures by `opts.label` (exact match first, then prefix match such as `actor:`). A responder may return `null` to simulate a dead agent → verify: unit test records two calls and returns fixture values.
3. `fakeParallel(thunks)` runs thunks in order and turns a throw into `null`. `fakePipeline(items, ...stages)` runs each item through the stages and passes `(prev, item, index)`; a throwing stage makes that item `null` → verify: unit tests for both, including the null cases.
4. `phase` and `log` push to arrays the test can read. `budget` is `{total: null, spent: () => 0, remaining: () => Infinity}` → verify: unit test.
5. `run(path, {args, fixtures})` returns `{result, calls, phases, logs, meta}`. A script that throws returns `{error}` instead → verify: unit test with a script that throws.

Done: `npm test` passes; the harness has no dependencies.

Model: sonnet xhigh. Size: about 45 minutes.

## Task 3: `swarm-prepare.js`

Depends on: Task 2. Parallel with: Task 4.

Files: `.claude/workflows/swarm-prepare.js`, `tests/swarm-prepare.test.js`, `tests/fixtures/prepare/`.

1. Write the `meta` block with phases `Extract`, `Merge`, `Plan`, `Personas`.
2. Extract: `parallel()` over `args.files`, one sonnet agent each (`label: extract:<file>`), returning entities, relations and claims through a schema (status enum `Fact | Assumption | Hypothesis | Unknown`, `source` as `file:line`). Log and count null extractors.
3. Merge: one sonnet agent (`label: merge`) gets every non-null extractor result inline, writes `<runDir>/ontology.json`, returns the ontology through a schema.
4. Plan: one opus agent (`label: plan`) reads the scenario file and gets the ontology inline. Its prompt states the mode rule, the cohort `role` rule, the 60-call cap, both actor-count formulas, and the default-rules file path. It writes `<runDir>/plan.json` and returns the plan, or `{error}`. On `{error}` the script returns `{error}` and runs nothing else.
5. Personas: `parallel()` over cohorts with `role: actor` and `personaCount > 0`, one sonnet agent each (`label: personas:<cohortId>`). The prompt inlines all of `plan.cohorts`, the ontology relations between cohorts, the cohort's ontology entity and claims, and `references/personas.md`. Each agent writes its files and returns its personas. The script drops and logs any persona whose id is not `<cohortId>-<n>` with `1 ≤ n ≤ personaCount`.
6. Return a summary: mode, variants, cohorts, persona `{id, name, slant}`, planned simulation calls, `budget.dropped`, and null or dropped counts.
7. Tests:
   - The lead-message-shaped fixture makes 5 extract, 1 merge, 1 plan and 4 persona calls (one per actor cohort, none for context cohorts).
   - A plan `{error}` stops the workflow after the plan call.
   - A persona with a bad id is dropped and logged.
   - A null extractor is logged and the merge still runs.
   - `meta.phases` titles match the `phase()` calls.
   - Every call sets `model`: opus for `plan`, sonnet for the rest.

Done: tests pass.

Model: sonnet xhigh. Size: about 1.5 hours.

## Task 4: `swarm-run.js`, journey mode plus shared tail

Depends on: Task 2. Parallel with: Task 3.

Files: `.claude/workflows/swarm-run.js`, `tests/swarm-run-journey.test.js`, `tests/fixtures/run/`.

1. Write the `meta` block with phases `Simulate`, `Analyze`, `Report`, `Check`.
2. Branch on `args.plan.mode`. In journey mode, assert `personas.length × variants.length ≤ plan.budget.cap` before any agent call; if not, return `{error}`.
3. Journey actors: `pipeline(variants, stage1, stage2)`. Stage 1 runs `parallel()` over personas, one sonnet agent each (`label: actor:<variant>/<personaId>`). The prompt inlines the persona, only this variant's `{id, label, description}`, the timeline and `args.facts`. It tells the agent not to read the scenario, the plan or other personas, and gives the log path `sim/<variant>/<personaId>.jsonl`. The schema returns the log lines.
4. Stage 2 is the analyst: one sonnet agent per variant (`label: analyst:<variant>`) with that variant's non-null actor results inline. It writes `analysis/<variant>.json` and returns it. Citations use `<variant>/<personaId>:<step>`.
5. Shared tail (both modes):
   - Report: one opus agent (`label: report`) gets all analyses, `plan.expectedOutputs` and the hypothesis-table format, and writes `report.md`.
   - Check: one sonnet agent (`label: check`) reads `report.md`, gets `plan.rules` and the citation formats inline, writes `check.json` and returns it. If clean, the same agent copies `report.md` to `report.final.md`.
   - Revise: only if check has items. One sonnet reviser (`label: revise`), then one sonnet second checker (`label: check-2`) that writes `check-2.json` and appends "Known issues" when items remain.
6. Coverage: count non-null actors and log every null. Pass the coverage line ("34 of 36 pairs completed") to the report prompt and include it in the return value.
7. Return `{reportPath, coverage, finalCheck}`.
8. Tests:
   - 12 personas × 3 variants makes 36 actor calls, 3 analysts, 1 report, 1 check, and 0 revise calls when the check is clean.
   - Over the cap returns `{error}` with 0 agent calls.
   - Each actor prompt contains exactly one variant's description text.
   - A null actor is logged and coverage reads "35 of 36".
   - A dirty check triggers exactly one `revise` and one `check-2`.
   - Model per label matches the spec; `meta.phases` match.

Done: tests pass.

Model: sonnet xhigh. Size: about 2 hours.

## Task 5: `swarm-run.js`, social mode

Depends on: Task 4.

Files: `.claude/workflows/swarm-run.js`, `tests/swarm-run-social.test.js`, `tests/fixtures/run/social/`.

1. Add `rankFeed(actions, persona, currentRound)` as a plain function in the script. It ranks posts and replies by `score = 2 × related + replies − (currentRound − postRound)`, breaks ties by `id` as an ascending string, and keeps the top 10.
2. Batching: 4 per batch, remainder last. Assert `ceil(personas / 4) × rounds × variants ≤ cap` before any agent call.
3. `pipeline(variants, roundLoop, analyst)`. The round loop runs `rounds` rounds. Each round, it runs one sonnet agent per batch (`label: social:<variant>/r<n>/b<k>`). The prompt inlines the variant text, each persona with its own `rankFeed` result (empty in round 1), the action ids to use (`r<n>-b<k>-0..`), and the round file path. The script checks the returned ids against the given sequence, logs and drops mismatches, and adds the kept actions to the variant's in-memory state.
4. The analyst gets the variant's full action list; citations use `<variant>/round-<n>/<actionId>`. The shared tail is the same as in Task 4.
5. Tests:
   - 9 personas, 3 rounds and 2 variants make `3 × 3 × 2 = 18` social calls.
   - Over the cap returns `{error}` with 0 calls.
   - Round 1 prompts show an empty feed.
   - A round-2 prompt's feed order matches a hand-computed `rankFeed` on the fixture, including a tie broken by id.
   - Mismatched action ids are dropped and logged.

Done: tests pass, and journey tests still pass.

Model: sonnet xhigh. Size: about 1.5 hours.

## Task 6: Agent reference files

Parallel with: Tasks 2 to 5.

Files: `.claude/skills/swarm-sim/references/formats.md`, `rules.md`, `personas.md`.

1. `formats.md`: every file format from the spec's Data formats section, the citation formats and the hypothesis table, with one example each.
2. `rules.md`: the default rules the plan agent copies into `plan.rules`:
   - label speculation as a hypothesis
   - every claim carries a citation
   - no measured or predicted rates or percentages unless the scenario asks
   - no fact claims beyond the pack's Facts
   - synthetic personas are not real customers
3. `personas.md`: how to write a persona. Each one is a cohort representative, has one clear slant, cites evidence refs, takes no traits from real customer records, and follows the id rule.

Done: an opus review confirms the files match the spec.

Model: sonnet (default effort). Size: about 30 minutes.

## Task 7: `SKILL.md`

Depends on: Tasks 3, 4 and 6 (needs final `args` shapes).

Files: `.claude/skills/swarm-sim/SKILL.md`.

1. Frontmatter: `name: swarm-sim` and a description that triggers on "run a swarm simulation", "MiroFish-style simulation" and `/swarm-sim`.
2. `prepare <packDir> <slug>`:
   1. Resolve `runDir = <packDir>/runs/<today>-<slug>`, adding `-2`, `-3` if the folder exists, and create it.
   2. List the top-level `*.md` files in `packDir` (never `runs/`).
   3. Call `Workflow({name: "swarm-prepare", args})`.
   4. Show the summary and stop at the checkpoint.
3. `run <runDir>`:
   1. Check that `plan.json` and `ontology.json` exist.
   2. Check `personas/` for exactly the expected `<cohortId>-<n>.json` files, and name any missing or extra files.
   3. Load the plan, personas and Fact claims, call `Workflow({name: "swarm-run", args})`, and report the result path, coverage and final check.
4. `interview <runDir> <personaId>`: load the persona file and that persona's log lines across variants, answer in character, and label anything outside the profile or logs as a hypothesis. No workflow.
5. Resume: if a workflow was interrupted, re-invoke with `resumeFromRunId` and the same `args`.

Done: an opus review checks each command against the spec; a dry read-through finds no step that needs a value it doesn't have.

Model: sonnet xhigh. Size: about 45 minutes.

## Task 8: Acceptance run on the sample pack

Depends on: Tasks 1 to 7 merged into the integration branch.

Files: `tests/acceptance-check.mjs`. Run outputs stay in the sample pack's `runs/` folder under `analysis/` and are never committed.

1. Write `tests/acceptance-check.mjs <runDir>`. It checks criteria 1, 5, 6, 7 and 8 automatically:
   - `plan.mode` and the variants
   - hypothesis table rows and non-empty cells
   - 0 violations and 0 untraced in the final check
   - the percentage grep
   - `plan.rules` contains the hypothesis and competitor rules

   It prints PASS or FAIL for each criterion.
2. Run `/swarm-sim prepare analysis/<app>/<pack> lead-message` → verify: the summary shows journey mode, 3 variants, 4 actor cohorts and 3 context cohorts.
3. Checkpoint: read the personas → verify: no persona copies a real customer detail from the pack's evidence file.
4. Run `/swarm-sim run <runDir>` → verify: coverage is reported and `report.final.md` exists.
5. Run `node tests/acceptance-check.mjs <runDir>` → verify: all automatic criteria PASS.
6. An opus reviewer reads `report.final.md` for criteria 2, 3 and 4 → verify: each objection, question and gap cites a log line that exists.
7. On any FAIL: fix the root cause in the prompt or script, add a harness test where possible, and re-run from the failing phase with `resumeFromRunId`.

Done: all 8 criteria pass; results go in the issue comment.

Model: the main loop runs the skill; opus reviews. Wall clock: about 30 to 45 minutes of agent time.

## Task 9: Review, merge, close

1. An opus `code-reviewer` reviews the full integration-branch diff → verify: no open correctness findings.
2. Run `npm test` on the integration branch → verify: all pass.
3. Merge the integration branch to `main` and push → verify: `git log --oneline -1` on `main`.
4. Close every sub-issue and the epic, and move them to Done on board #9. Remove worktrees and branches.

## Order and parallelism

```
Task 1
  then Task 2 (with Task 6 alongside)
    then Task 3 and Task 4 in parallel
      then Task 5
        then Task 7 (after 3, 4, 6)
          then Task 8
            then Task 9
```

Estimated total: about 8 hours of agent work. About 5 hours of wall clock with the parallel tasks.

## Out of scope for v1

- A social-mode acceptance run on real input.
- Any UI.
- Import of MiroFish projects or KuzuDB graphs.
