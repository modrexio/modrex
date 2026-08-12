# CLAUDE.md

This file is the canonical guide for the Modrex product monorepo.

## Repository structure

| Path | Purpose |
| --- | --- |
| apps/desktop/ | Tauri v2 desktop application (Rust + React) |
| apps/site/ | Astro marketing and documentation site |
| apps/index/ | Mod-identification index builder |
| packages/games/ | Shared declarative game data (added after structural migration) |
| install.config.json | Root-level public contract consumed by modrex.net/install.sh |

Read the CLAUDE.md inside the relevant application before working in it. During the
migration, applications not yet under apps/ remain in their existing repositories and
continue operating independently.

## Root commands

The root commands run the quality gates for every workspace application; desktop build
and release commands remain desktop-specific:

```sh
pnpm install
pnpm dev
pnpm build
pnpm checks
pnpm test
pnpm version patch|minor|major
```

Project-specific commands can also be run from the application directory.

## Translation ownership

English is the source language for product work. When a task needs localized strings, edit only
`apps/desktop/src/renderer/src/i18n/en.json` unless the user explicitly requests a translation
task for specific named locales. Never create, update, synchronize, backfill, or otherwise alter
a non-English locale as part of a feature, fix, refactor, or documentation task. Missing
translations are expected to fall back to English and are completed separately by language
contributors.

Translation-only contributions should stay focused when practical. Human contributors may
include relevant translations with product changes; this does not change the AI restriction
above.

## Permanent compatibility contracts

- Bare vX.Y.Z tags and GitHub Releases belong to the desktop application.
- install.config.json stays at the repository root.
- Desktop versions through 0.12.2 continue downloading the legacy monolithic `index.db`
  from `modrexio/modrex-index`'s `latest-index` release. The new index pipeline stores
  its resumable catalog in Neon, publishes immutable per-game SQLite shards to R2 at
  `index.modrex.net`, and the site reads its aggregate stats from R2's `catalog/latest.json`.
- modrexio/mget remains an independent repository and tag host.
- Never run a git command that touches a remote. Write the command for the owner instead.
- Never commit unless the owner explicitly approves the reviewed step.

See docs/architecture/monorepo-migration.md for migration order and invariants.
