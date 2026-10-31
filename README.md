# swarm-sim

swarm-sim is a MiroFish-style simulation that runs on Claude subagents through the Workflow tool. It reads a seed pack, builds an ontology, writes synthetic personas, simulates how those personas react to a scenario, and writes a checked report. It is a Claude Code project skill plus two saved workflows, so you run it from this repo and pass the path to your pack.

## Commands

- `/swarm-sim prepare <packDir> <slug>` reads the pack and writes the ontology, the plan and the personas, then stops so you can review and edit them.
- `/swarm-sim run <runDir>` simulates the approved plan, then writes, checks and finalizes the report.
- `/swarm-sim interview <runDir> <personaId>` answers your questions in the voice of one persona from a finished run.

## Where outputs go

Each run is written to a folder next to the pack, under `<packDir>/runs/`.

Keep packs in the git-ignored `analysis/` folder, one subfolder per app:

```
analysis/<app>/<NN>_<name>_pack/runs/<date>-<slug>/
```

`.gitignore` ignores every top-level path except the publishable ones it lists, so `analysis/` is never committed. The scripts refuse any other pack or run path inside this repo. A pack outside the repo works too.

## Data safety

Packs can hold personal customer data. Never commit pack contents or run outputs. Run folders live in `<packDir>/runs/`, never in this repo.

## Tests

```
npm test
```

This runs `node --test tests/` and needs no dependencies.

## Docs

- Design: [docs/superpowers/specs/2026-10-31-swarm-sim-design.md](docs/superpowers/specs/2026-10-31-swarm-sim-design.md)
- Implementation plan: [docs/superpowers/plans/2026-10-31-swarm-sim-plan.md](docs/superpowers/plans/2026-10-31-swarm-sim-plan.md)

## License

MIT. See [LICENSE](LICENSE).
