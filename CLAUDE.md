# swarm-sim

Claude Code project skill and saved workflows that replicate MiroFish: seed pack, ontology, personas, simulation, checked report. Design: `docs/superpowers/specs/2026-10-31-swarm-sim-design.md`.

## Data safety

Packs live under the git-ignored `analysis/<app>/` folder, or anywhere outside this repo. Run folders are written next to the pack (`<packDir>/runs/`). `.gitignore` ignores every top-level path except the publishable ones it lists; keep it that way. Packs can hold personal customer data. Never commit pack contents or run outputs.
