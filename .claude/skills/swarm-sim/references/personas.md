# How to write personas

You write the personas for one `actor` cohort. The plan gives you the cohort's `personaCount`. Write exactly that many personas. Return them and write one file per persona. See `formats.md` for the file shape.

## What a persona is

1. Make each persona a representative of its cohort. It stands for a type of person in that cohort. It is not a real customer.
2. Give each persona one clear slant. The slant is the angle that sets it apart from the other personas in the same cohort. Write it as one sentence. No two personas in a cohort share a slant.
3. Ground every goal and constraint in the cohort's ontology claims. Each goal and constraint must follow from at least one claim you list in `evidenceRefs`. Use the claim's `source` (`file:line`) as the reference.
4. Do not turn a claim with status `Assumption`, `Hypothesis` or `Unknown` into a stated fact in the profile. Write it as a tendency.
5. Take no trait from an individual real customer record. Do not copy names, emails, ids, birth dates or any detail that identifies a person. Never give a persona a personal first name or surname, because an invented name can match a real customer. The `name` field is the role label the workflow gives you, for example `First Log 2` for `Parent_FirstLog_Representative-2`.

## The id rule

1. Set `id` to `<cohortId>-<n>`.
2. Count `n` from 1 up to `personaCount`. Do not skip a number. Do not start at 0.
3. Use the cohort's `id` from `plan.cohorts`, spelled exactly.
4. Set `cohortId` to the same cohort `id`.

The workflow drops any persona whose id does not match. It does not repair ids.

## relatedIds

1. Look at the ontology relations that link your cohort's entity to another cohort's entity. Use `cohort.entityId` to find the entity. A relation counts in either direction.
2. For each such relation, you may list persona ids from the related cohort.
3. Derive those ids from `plan.cohorts`. For a cohort with `personaCount` of 3, the ids are `<cohortId>-1`, `<cohortId>-2` and `<cohortId>-3`.
4. List only cohorts that have `personaCount` above 0. A `context` cohort has no personas.
5. Leave `relatedIds` as `[]` when no relation links your cohort to another actor cohort.

## Good example

```json
{
  "id": "Parent_FirstLog_Representative-2",
  "cohortId": "Parent_FirstLog_Representative",
  "name": "First Log 2",
  "profile": "A new parent who reads listings closely before installing anything.",
  "goals": ["Know what the app does before creating an account."],
  "constraints": ["Has little time, so skims the first lines of a listing."],
  "slant": "Skeptical of free offers until the listing explains how the app earns money.",
  "evidenceRefs": ["scenario.md:6"],
  "relatedIds": ["Parent_Returning_Representative-1"]
}
```

This persona is good because:

- The id follows `<cohortId>-<n>`.
- It has one clear slant that other personas in the cohort can differ from.
- The goal and the constraint follow from a cited claim.
- It holds no detail from a real record.

## Bad example

```json
{
  "id": "FirstLog-0",
  "cohortId": "Parent_FirstLog_Representative",
  "name": "Priya Nair",
  "profile": "Customer 4821, priya@example.com, born 1991-03-02. Loves the app and will pay 70 percent more.",
  "goals": ["Buy the premium plan."],
  "constraints": [],
  "slant": "A typical parent.",
  "evidenceRefs": [],
  "relatedIds": ["Grandparent_Representative-1"]
}
```

This persona is bad because:

- The id is not `<cohortId>-<n>`, and `n` starts at 0. The workflow would drop it.
- It uses a personal name instead of the role label, and copies a real person's email, id and birth date.
- It states a real customer's preference and a percentage as fact.
- Its slant is vague, so it does not set the persona apart.
- It has no `evidenceRefs`, so nothing grounds the goal.
- It lists a persona from a `context` cohort, and no persona files exist for that cohort.

(The values in this example are made up for illustration.)
