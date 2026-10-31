# Default rules

The plan agent copies these rules into `plan.rules`. The checker later tests the report against every entry in `plan.rules`.

## The rules

1. Label every speculative reason as a hypothesis.
2. Give every claim in a report at least one citation in the formats in `formats.md` (`<variant>/<personaId>:<step>` or `<variant>/round-<n>/<actionId>`, or `variant:<id>` for text that restates a variant description).
3. State no measured or predicted rates or percentages unless the scenario explicitly asks for them; naming a metric is allowed.
4. State nothing as fact beyond the pack's Fact claims.
5. Treat every persona as a synthetic representative of a cohort, not a real customer, and never state real customers' preferences.
6. Do not copy personal details (names, emails, ids, birth dates) from pack evidence into any output.
7. Show an actor only its own variant.

## Merge with the scenario's rules

The scenario file has its own "must not produce" section and "rules" section. Merge them with the default rules like this.

1. Put all seven default rules into `plan.rules` first. Keep each as one string.
2. Add every item from the scenario's "must not produce" section and "rules" section as its own entry. Write each as one imperative sentence. Keep the scenario's meaning and key wording, because the checker and the acceptance test look for it.
3. Keep both entries when a scenario rule overlaps a default rule but names something extra. Do not delete a scenario rule because a default rule covers a similar point.
4. When a scenario rule and a default rule conflict, so that both cannot hold, keep the stricter one and drop the other. The stricter rule allows less. Example: a default rule allows naming a metric, and the scenario forbids naming any metric. Keep the scenario rule.
5. Never drop a default rule because a scenario rule is weaker. A scenario can only add or tighten rules. The one exception is written into the default rule itself: rule 3 lifts when the scenario explicitly asks for rates or percentages.
6. Remove an entry only when another entry says the same thing in the same or stricter words.
