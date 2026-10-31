# File formats

Read this file before you write or read any swarm-sim file.

- Use the field names exactly as written here. Do not rename, add or drop fields.
- Every file is JSON, except `report.md`, `report.final.md` and the `.jsonl` journey logs.
- Write only the files your prompt names. The report and check agents write no file: they return their result, and the main loop saves it.
- The examples are small and generic. They show the shape only. Never copy their values into real output.

## Run folder layout

The run folder is `<packDir>/runs/<YYYY-MM-DD>-<slug>/`.

```
<packDir>/runs/<YYYY-MM-DD>-<slug>/
  ontology.json
  plan.json
  personas/<personaId>.json
  sim/<variant>/<personaId>.jsonl      journey mode
  sim/<variant>/round-<n>/<batch>.json social mode
  analysis/<variant>.json
  run-result.json
  report.md
  check.json
  check-2.json
  check-3.json
  report.final.md
```

## ontology.json

The ontology holds what the pack says, in four lists.

- `entityTypes`: list of `{name, description}`.
- `entities`: list of `{id, type, name, summary, source}`.
- `relations`: list of `{from, to, type, status, source}`. `from` and `to` are entity ids.
- `claims`: list of `{text, status, source}`.

`status` is one of `Fact`, `Assumption`, `Hypothesis` or `Unknown`. Copy the pack's own label where one exists. `source` is `file:line`.

```json
{
  "entityTypes": [{"name": "Cohort", "description": "A group of parents in a similar situation."}],
  "entities": [
    {"id": "Parent_FirstLog_Representative", "type": "Cohort", "name": "First-log parent", "summary": "A parent who is about to log a first feed.", "source": "personas.md:14"},
    {"id": "Partner_Representative", "type": "Cohort", "name": "Partner", "summary": "The other caregiver at home.", "source": "personas.md:30"}
  ],
  "relations": [
    {"from": "Parent_FirstLog_Representative", "to": "Partner_Representative", "type": "invites", "status": "Assumption", "source": "personas.md:22"}
  ],
  "claims": [
    {"text": "The listing is the first thing a new parent reads.", "status": "Fact", "source": "scenario.md:6"}
  ]
}
```

## plan.json

The plan sizes the run.

- `mode`: `journey` or `social`.
- `variants`: list of `{id, label, description}`. `description` is the variant text that actors see.
- `cohorts`: list of `{id, entityId, role, personaCount, reason}`. `role` is `actor` or `context`. A `context` cohort has `personaCount: 0` and gets no persona files.
- `timeline` (journey mode): ordered list of `{step, label, description}`.
- `rounds` (social mode): the number of rounds. Give its `reason` next to it.
- `rules`: list of rules. Each entry is one string. See `rules.md`.
- `expectedOutputs`: list of strings taken from the scenario's "what the simulation should produce" section.
- `budget`: `{simulationAgentCalls, cap, dropped}`. `cap` is 60. `dropped` lists anything cut to stay under the cap, as one string per item that names what was cut and why. `dropped` is empty when nothing was cut.

```json
{
  "mode": "journey",
  "variants": [
    {"id": "A", "label": "Message A", "description": "Free baby tracking and family sharing"},
    {"id": "B", "label": "Message B", "description": "Predict your baby's next nap"},
    {"id": "baseline", "label": "Current mixed message", "description": "The listing as it reads today."}
  ],
  "cohorts": [
    {"id": "Parent_FirstLog_Representative", "entityId": "Parent_FirstLog_Representative", "role": "actor", "personaCount": 3, "reason": "Three slants cover the range of first-week doubts."},
    {"id": "Partner_Representative", "entityId": "Partner_Representative", "role": "context", "personaCount": 0, "reason": "Appears only in a parent's invite step."}
  ],
  "timeline": [
    {"step": 1, "label": "See the listing", "description": "The persona reads the listing and decides whether to install."},
    {"step": 2, "label": "First week", "description": "The persona decides whether to keep using the app."}
  ],
  "rules": ["Label every speculative reason as a hypothesis."],
  "expectedOutputs": ["Objections for each message, by cohort."],
  "budget": {"simulationAgentCalls": 9, "cap": 60, "dropped": []}
}
```

In social mode, replace `timeline` with `"rounds": 3` and `"reason": "Three rounds let replies build on posts."`.

## personas/<personaId>.json

One file per persona. The file name is `<personaId>.json`.

`{id, cohortId, name, profile, goals, constraints, slant, evidenceRefs, relatedIds}`

- `id` is `<cohortId>-<n>`, with `n` counting from 1 up to the cohort's `personaCount`.
- `profile` is a short text. `goals` and `constraints` are lists of short texts.
- `slant` is the angle that makes this persona differ from the others in its cohort.
- `evidenceRefs` is a list of ontology claim `source` values (`file:line`).
- `relatedIds` lists the persona ids this persona relates to. Only social mode uses it. It may be empty.

See `personas.md` for how to write each field.

```json
{
  "id": "Parent_FirstLog_Representative-1",
  "cohortId": "Parent_FirstLog_Representative",
  "name": "Mara",
  "profile": "A new parent who wants one quick way to log feeds.",
  "goals": ["Log a feed in a few taps."],
  "constraints": ["Reads the listing on a phone, one-handed."],
  "slant": "Distrusts any feature that asks for data before it shows value.",
  "evidenceRefs": ["scenario.md:6"],
  "relatedIds": []
}
```

## Journey log line

Each actor writes one JSON object per line to `sim/<variant>/<personaId>.jsonl`. Write one line per timeline step. Put no line breaks inside an object.

`{step, variant, sees, decision, reason, quote, label}`

- `step` is the timeline `step` value.
- `variant` is the variant `id`.
- `sees` is what the persona sees at this step.
- `decision` is what the persona does at this step.
- `reason` is why.
- `quote` is one sentence in the persona's own voice.
- `label` is `Fact` when the reason rests on a pack Fact. Otherwise it is `Hypothesis`.

```json
{"step": 1, "variant": "A", "sees": "The first line of the listing and two screenshots.", "decision": "install", "reason": "Free tracking removes the cost risk for a first try.", "quote": "If it is free I can just try it tonight.", "label": "Hypothesis"}
```

## Social round file

`sim/<variant>/round-<n>/<batch>.json` holds the actions of one batch in one round.

`{round, batch, actions: [{id, personaId, type, targetId, text, label}]}`

- `type` is `post`, `reply`, `like` or `ignore`.
- `id` is `r<round>-b<batch>-<i>`. `i` is the action's index in your returned list, counting from 0. Use the ids you are given, in order. Do not choose your own.
- `targetId` is the `id` of an earlier action. It is empty for `post`.
- `label` is `Fact` or `Hypothesis`, as in the journey log line.

```json
{
  "round": 2,
  "batch": 1,
  "actions": [
    {"id": "r2-b1-0", "personaId": "Parent_FirstLog_Representative-1", "type": "post", "targetId": "", "text": "Does it work without an account?", "label": "Hypothesis"},
    {"id": "r2-b1-1", "personaId": "Parent_FirstLog_Representative-2", "type": "reply", "targetId": "r1-b1-0", "text": "Same question here.", "label": "Hypothesis"}
  ]
}
```

## Citation formats

A citation points to one line in the simulation logs. Use exactly these formats.

- Journey mode: `<variant>/<personaId>:<step>`. Example: `A/Parent_FirstLog_Representative-1:3` is step 3 of persona `Parent_FirstLog_Representative-1` under variant `A`.
- Social mode: `<variant>/round-<n>/<actionId>`. Example: `B/round-2/r2-b1-0` is action `r2-b1-0` in round 2 under variant `B`.

- Variant wording: `variant:<id>`. Example: `variant:baseline` points to the description of variant `baseline` in `plan.json`. Use it only for text that restates a variant description. It supports nothing a persona said or did.

A citation is valid only when the log line exists and supports the claim.

## analysis/<variant>.json

One file per variant. An analyst reads that variant's logs and lists three kinds of finding.

- `objections`: reasons a persona resists or rejects the variant.
- `unansweredQuestions`: questions a persona has that the variant does not answer.
- `expectationGaps`: expectations the persona has that the product, as shown, does not meet.

Each of the three is a list of `{text, cohortId, citation}`. `cohortId` is the cohort of the cited persona. `citation` uses the citation format for the run's mode. Every item has exactly one citation.

```json
{
  "objections": [
    {"text": "The persona doubts that free tracking stays free.", "cohortId": "Parent_FirstLog_Representative", "citation": "A/Parent_FirstLog_Representative-1:1"}
  ],
  "unansweredQuestions": [
    {"text": "The persona asks whether the app needs an account.", "cohortId": "Parent_FirstLog_Representative", "citation": "A/Parent_FirstLog_Representative-2:1"}
  ],
  "expectationGaps": [
    {"text": "The persona expects a nap prediction in week one.", "cohortId": "Parent_FirstLog_Representative", "citation": "B/Parent_FirstLog_Representative-1:2"}
  ]
}
```

## Hypothesis table

The report puts all hypotheses in one markdown table with this header:

| # | If the listing leads with (X) | then this changes (Y) | measured by (Z) | Citations |
|---|---|---|---|---|

Each row reads as "If the listing leads with X, then Y changes, measured by Z". X, Y, Z and Citations must each be non-empty. Z may name a metric. Z must not state or predict its value. Citations use the citation formats above.

| # | If the listing leads with (X) | then this changes (Y) | measured by (Z) | Citations |
|---|---|---|---|---|
| 1 | Message A | Fewer first-week doubts about cost | Product page conversion rate | A/Parent_FirstLog_Representative-1:1 |

## check.json, check-2.json and check-3.json

The checker reads the report, `plan.rules` and the logs and returns the check. The main loop saves it as `check.json`. After the first revision, the next check is saved as `check-2.json`. If that check still has items, a second revision follows and its check is saved as `check-3.json`. No check overwrites an earlier one.

`{violations, untraced}`

- `violations`: list of `{rule, quote, fix}`. `rule` is the rule from `plan.rules` that the report breaks. `quote` is the offending text from the report. `fix` is the change that would resolve it.
- `untraced`: list of claims from the report. Each entry is the claim text. List a claim here when its citation is missing, malformed, points to a log line that does not exist, or points to a line that does not support the claim.

A clean check has two empty lists.

```json
{
  "violations": [
    {"rule": "State no measured or predicted rates or percentages unless the scenario explicitly asks for them; naming a metric is allowed.", "quote": "Message B will lift installs.", "fix": "Remove the prediction. Name the metric only."}
  ],
  "untraced": ["Parents in the first cohort distrust free offers."]
}
```
