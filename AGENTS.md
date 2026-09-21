# Agents

This file is the canonical instruction set for every AI coding agent working in this
repository. Every `CLAUDE.md` in the repository is a one-line import of the `AGENTS.md`
beside it and holds nothing of its own.

## How these instructions are organized

- This file holds what applies everywhere.
- A directory that carries an `AGENTS.md` owns the rules for the files under it. Read the
  nearest `AGENTS.md` above each file you change before changing it, whether or not your
  tool loads nested files on its own.
- `AI_DANGER_PATTERNS.md` holds worked examples of the five dangerous patterns below.
- Reusable skills live in `.agents/skills/<name>/SKILL.md`. Load the relevant skill before
  executing it. Claude Code exposes them as slash commands through `.claude/commands/`.
- `docs/README.md` routes the contributor documentation.

## Repository rules

- Never run any git command that touches the remote (push, push tag, delete tag, force
  push) or is destructive locally (tag -d, reset --hard). Write the command for the owner
  instead.
- Never commit unless the owner explicitly approves the reviewed step.
- Commit messages must follow conventional commits, `type(scope): subject`, enforced by
  `commitlint.config.ts` at commit time.
- Deferred work is tracked in `.TODO`. Do NOT act on anything in it unless the user
  explicitly says "do the TODO: <name>" — never infer intent from the file on your own.

## Permanent compatibility contracts

- Bare vX.Y.Z tags and GitHub Releases belong to the desktop application.
- `install.config.json` stays at the repository root, and it is live install
  infrastructure, not local config: the modrex-site Pages Function behind
  `modrex.net/install.sh` fetches it from this repo's `main` branch on every request and
  prepends it (flattened to `CFG_*` shell exports) to the pinned mget install engine, so a
  push to `main` that touches it changes the live Linux installer immediately, with no
  release or site deploy involved. Field meanings are defined by mget's config schema
  (`mget/README.md`).
- Desktop versions through 0.12.2 continue downloading the legacy monolithic `index.db`
  from `modrexio/modrex-index`'s `latest-index` release. The new index pipeline stores
  its resumable catalog in Neon, publishes immutable per-game SQLite shards to R2 at
  `index.modrex.net`, and the site reads its aggregate stats from R2's `catalog/latest.json`.
- modrexio/mget remains an independent repository and tag host.

See docs/architecture/public-contracts.md for what each contract protects, and
docs/architecture/game-packages.md for how game packages are discovered and loaded.

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

The one exception to the restriction is the translation-status workflow, which writes `!`
scaffolds and `?` review markers into non-English locales. Those are mechanical: they copy
English or re-mark existing translated text, and they never invent a translation. A change to
`en.json` alone is complete and passes CI on its own; the bot materializes the markers, the
contributor table, the README block and the status SVGs afterwards. See
docs/architecture/i18n-ownership.md.

## Code style

AI-assisted work is allowed, but raw AI-shaped code is not. These five patterns are
blocker-level because they can hide bugs or break Modrex-specific behavior. Do not leave
them in any change; `AI_DANGER_PATTERNS.md` shows each one.

1. Silent catch / silent fallback
2. Generic helpers replacing game-specific logic
3. Defensive checks that hide broken invariants
4. Deep `if`/`else` nesting
5. Fake abstractions / speculative future-proofing

### Silent catch / fallback

Do not hide failures with empty values.

Do not catch errors unless you can add context, recover, or show useful feedback.

### Domain-specific logic

Do not replace game-specific, loader-specific, store-specific, or archive-specific behavior
with generic helpers unless all invariants are preserved.

### Invariants

Validate at boundaries. Do not add defensive checks inside trusted code paths.

### Control flow

Keep the happy path flat. Use guard clauses for invalid or unsupported cases.

Do not use `else` after `return`, `throw`, `continue`, or `break`.

### Abstractions

Do not add managers, factories, adapters, options, flags, or modes for hypothetical future use.

Extract helpers only for real duplication, real domain names, or real boundaries.

### Comments

A comment states a constraint the code cannot show. Default shape: one to four
lines saying the constraint and what breaks without it. Delete comments that
repeat the code.

Write comments as plain prose: full sentences, commas and periods, plain ASCII.
No backticks around identifiers, no semicolons chaining clauses, no arrows, no
dashes as separators, no em dashes. Write save_state, not `save_state`. Markup
reads as noise to contributors viewing raw source.

No history. A comment describes the present code, never the change that
produced it. Words like "previously", "used to", "no longer", "renamed from"
mark commit-message content sitting in the wrong place.

Every durable fact gets exactly one home:

- enforceable: a check script or test, with a one-line comment naming it
- needed when editing this exact code: an inline comment at the site. This is
  the canonical home and the only layer GitHub contributors ever see.
- module map or cross-file wiring: the nearest `AGENTS.md`, which points to site
  comments and never restates them
- rationale for a change: the commit message only

Longer blocks stay reserved for:

- file formats, archive structure, wire protocols
- algorithm provenance and reference implementations (pdmod.rs's Bob Jenkins
  hash port, the .pdmod format header)
- security-sensitive assumptions or path-traversal guards
- major sections in complex files

Doc comments on pub items: one sentence on what, one more for the non-obvious
part when there is one. Not every item needs one.

Do not "clean up" the reserved kinds just because they are comments. Reviewing
existing code against this section is the comment-audit skill's job.

### Final pass

Before reporting completion of a code change, run mentally or explicitly:

- `danger-audit` for the five dangerous patterns, before finishing any non-trivial change
- `deslop` for general AI-shaped code, before finishing any AI-assisted change
- `control-flow` when a change touches validation, branching, installation logic,
  filesystem routing, renderer event handlers, or any function with nested conditionals
- `comment-audit` after AI-assisted edits, large refactors, or any change that adds comments
- `ai-review` before proposing a PR, commit, or final summary for a non-trivial change

## AI-facing documentation

The `AGENTS.md` files, `AI_DANGER_PATTERNS.md`, the skills and the agent adapters are
AI-facing documentation. Every line in an `AGENTS.md` is paid for by every session that
loads it, so the bar for adding one is that the fact is difficult, expensive, unsafe or
unreliable to reconstruct from the repository itself. Usefulness alone is not the bar.

Document:

- architectural invariants and boundaries
- compatibility contracts
- safety-critical constraints
- the rationale behind a design decision that the code cannot show
- project-specific workflows that cannot be inferred from code or configuration
- gotchas, exceptions and historical constraints that are easy to violate
- rules governing how agents modify the repository

Do not document what a cheap inspection of the repository gives:

- directory or file inventories
- package scripts and ordinary commands already present in a manifest or config file
- test file inventories or test counts
- lists of translation namespaces, UI variants, constants or other values visible in source
- prose that restates what nearby code already expresses
- a rule that already has a canonical home elsewhere; point to the home instead
- repository state that changes often enough to go stale

Maintenance rules:

- One canonical home per rule. Do not repeat a rule across `AGENTS.md` files, `CLAUDE.md`,
  agent-specific configuration or skills without a strong technical reason.
- Shared rules live in agent-neutral files. Agent-specific files (`CLAUDE.md`, `.claude/`,
  and equivalents for other tools) are thin entry points that import or point to the shared
  file and never hold project knowledge of their own.
- Scope narrowly. Knowledge about one directory belongs in that directory's `AGENTS.md`,
  not in a parent that loads for unrelated work. A cross-cutting invariant sits at the
  lowest directory that contains every file it governs.
- Justify the context cost. A fact an agent can reliably discover with one or two tool
  calls is usually not worth permanent injection.
- Preserve rationale and invariants when implementation details change: update the detail,
  keep the why.
- No exact counts, inventories or snapshots unless something automated keeps them in sync.
- Prefer updating an existing section to adding a new one. When the architecture changes,
  remove or consolidate what it made obsolete instead of appending.
- Keep the structure usable by Claude Code, Codex and other agents alike. A mechanism only
  one tool understands must point at the shared file, never replace it.
