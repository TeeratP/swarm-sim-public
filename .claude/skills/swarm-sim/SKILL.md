---
name: swarm-sim
description: Run a MiroFish-style swarm simulation on a seed pack. Use for "/swarm-sim", "swarm simulation", "MiroFish-style simulation" or any request to simulate personas reacting to a scenario. Commands are prepare, run and interview.
---

# swarm-sim

Reads a seed pack, builds an ontology and synthetic personas, simulates how they react to the pack's scenario, and writes a checked report. Three commands:

- `/swarm-sim prepare <packDir> <slug>`
- `/swarm-sim run <runDir>`
- `/swarm-sim interview <runDir> <personaId>`

If an argument is missing, ask the user for it. Never guess a path.

## Setup

`<repoRoot>` is the swarm-sim repo that holds this skill: three folders up from the folder that holds this SKILL.md. Resolve it once with `git -C <that folder> rev-parse --show-toplevel` and reuse it.

All file work is done by `node <repoRoot>/scripts/swarm-args.mjs`. It prints one line of JSON, and on failure prints `{"error": "..."}` and exits 1. Never build workflow `args` by hand. If the output is cut off mid-JSON, stop and tell the user. Do not rebuild it.

To call a workflow, use the Workflow tool with `name` and `args`. Pass `args` as a real object (the parsed JSON, not a string) and change no field. If the tool does not find the name, call it again with `scriptPath: "<repoRoot>/.claude/workflows/<name>.js"` instead of `name`.

## prepare

1. Run `node <repoRoot>/scripts/swarm-args.mjs prepare <packDir> <slug>`. It creates the run folder and prints `{packDir, runDir, files, referencesDir}`. On `error`, show it and stop.
2. Call Workflow with `name: "swarm-prepare"` and `args` = that JSON.
3. When it returns:
   - On `error`, show it and stop. The run folder from step 1 stays on disk. If the error says the pack has no scenario file, ask the user for one: a file in `<packDir>` with "scenario" in its name.
   - Otherwise show the checkpoint summary: mode, variants, cohorts with their role and persona count, each persona's id, name and slant, planned simulation calls, `dropped` items, and `problems` (null extractors, dropped personas, null persona agents).
4. Tell the user they can edit `<runDir>/plan.json` and `<runDir>/personas/*.json` now. Ask with AskUserQuestion whether to run now. Never start `run` without that answer. If the user says yes, go to `run` with this `runDir`. Otherwise stop and give them `/swarm-sim run <runDir>`.

## run

1. Run `node <repoRoot>/scripts/swarm-args.mjs run <runDir>`. It checks `plan.json`, `ontology.json` and the expected `personas/<cohortId>-<n>.json` files, writes `<runDir>/facts.json`, and prints `{packDir, runDir, plan, personaRefs, factsPath, referencesDir}`. Personas and facts go by reference: `personaRefs` lists each persona file's path and `factsPath` is the path of `facts.json`, so the agents read them from disk. On `error`, show it (it names each missing or extra file) and stop. Tell the user to re-run `prepare` or fix those files.
2. Call Workflow with `name: "swarm-run"` and `args` = that JSON.
3. When it returns:
   - On `error`, show it with `coverage` and stop. One exception: an error that comes with `files` means a revision or its re-check failed. The files hold the last checked report with its Known issues. Save the files as in the next bullet first, then show the error.
   - Otherwise save the report. The workflow's agents may not write report files, so it returns the report and check content as `files`. Write the whole return value to `<runDir>/run-result.json` with the Write tool. Then run `node <repoRoot>/scripts/swarm-args.mjs save <runDir> <runDir>/run-result.json`. It writes each entry of `files` into `<runDir>` and prints `{written, reportFinalPath}`. On `error`, show it and stop.
   - Report `coverage` and the number of `finalCheck.violations` and `finalCheck.untraced`. If either is above 0, say the report ends with a "Known issues" section.
   - Read `reportFinalPath` (`report.final.md`) and show its hypothesis table: the markdown table whose header starts `| # | If the listing leads with (X)`.

## interview

1. Run `node <repoRoot>/scripts/swarm-args.mjs interview <runDir> <personaId>`. It prints `{persona, logs}`. On `error`, show it and stop. If the user gave no `personaId`, list the file names in `<runDir>/personas/` and ask which one.
2. Answer the user's questions in character, in the first person, as that persona.
   - Use only the `persona` fields and the `logs`. Mark anything else you say with "(hypothesis)". A log line labeled `Hypothesis` stays a hypothesis when you repeat it.
   - When you draw on a log line, cite it with its `citation` value, for example `A/Parent_FirstLog_Representative-1:2` (journey) or `B/round-2/r2-b1-0` (social).
   - The persona is a synthetic representative, not a real customer. Never state what real customers prefer, and invent no personal details.
   - If `logs` is empty, say the run has no log for this persona.
3. Stay in character until the user says stop. Then leave the persona and confirm.

## Resume

If a workflow stops partway, call Workflow again with the same `name`, `resumeFromRunId` set to the run ID the tool reported, and the exact `args` object from the first call. Do not run `prepare` again and do not create a new run folder. If the `args` are no longer in the conversation, rebuild them with the CLI only for `run` (it is safe to repeat); for `prepare`, tell the user to start a fresh `prepare`.

An `{error}` that the workflow returns itself is not an interruption. Fix its cause (edit the plan or personas, add a scenario) and start the command again.

## Data safety

Run outputs stay in `<packDir>/runs/`. Never copy pack contents or run outputs into this repo, and never commit them. Packs can hold personal customer data.
