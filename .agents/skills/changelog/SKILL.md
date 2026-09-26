---
name: changelog
description: Add user-facing entries to CHANGELOG.md's Unreleased section for recent changes
---

# changelog

Add entries to [`CHANGELOG.md`](../../../CHANGELOG.md)'s `## Unreleased` section for
changes that haven't been recorded yet. Never touch a released (`## X.Y.Z`) section.
Version headings have no brackets and no date — just the bare number (e.g. `## 0.10.0`).

## Scope

Determine which changes to record based on the argument passed:

- **No argument** — find the last tag (`git describe --tags --abbrev=0`) and read
  `git log <tag>..HEAD` (full messages, not just subjects). Compare against what's
  already under `Unreleased` and add only what's missing — safe to re-run after every
  change.
- **A ref or range** (e.g. `HEAD~3..HEAD`, a single SHA) — read exactly that range
  (`git log <range>`, `git show <sha>`).
- **Uncommitted changes** — if there's nothing new in the commit log but `git status`
  shows a dirty tree, read `git diff HEAD` instead.

Read full commit messages and diffs, not just subject lines — a one-line `fix:` subject
often hides the user-facing detail worth recording (or reveals it's purely internal).

## Categorization

Use [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) sections, in this order:
**Added**, **Changed**, **Fixed**, **Security** (add **Deprecated** / **Removed** only
if genuinely applicable).

Commit type is a starting hint, not the final answer:

- `feat` → Added
- `fix` → Fixed, **unless** the change addresses a security issue (path traversal,
  injection, URL/scheme handling, CSP, auth, secrets) — those go in **Security**
  regardless of commit type. Read the diff to tell an ordinary bug from a
  security-relevant one.
- `perf` → Changed
- `refactor`, `test`, `docs`, `chore`, `ci`, `build`, `style` → **skip** — never enters
  the changelog. Same for dependency bumps, license regen, and version-bump commits.
- Anything with no observable effect for someone using the app → skip, regardless of
  conventional-commit type.

## Writing entries

- One bullet per user-facing change, in product voice, past tense: "Added X.", "Fixed Y
  appearing when Z.", not commit subjects, hashes, scopes, or issue numbers.
- If several commits implement one feature or fix, merge them into a single bullet —
  the changelog reflects shipped behavior, not commit-by-commit history.
- If a commit fixes something introduced earlier in the same `Unreleased` block (the
  buggy behavior was never released), fold the fix into the existing Added bullet
  instead of adding a separate Fixed line for code users never saw broken.
- If a commit adds a sub-detail to an unreleased feature (e.g. a progress counter
  added to a modal that itself hasn't shipped), fold it into the existing bullet for
  that feature — never add a separate entry for behavior users haven't seen without it.
- Keep entries short. Don't describe a feature's internal contents unless the detail
  is itself the user-facing point — "Added a per-mod options menu." is enough; listing
  what's inside the menu is not.
- No Unicode arrows/symbols — plain words ("becomes", "to", "via").
- Match the tone already in `CHANGELOG.md`'s released sections — read a couple before
  writing new ones.

## Procedure

1. Resolve scope (see above) and read the actual diffs, not just messages.
2. If nothing in scope is user-facing, say so and stop — do not invent an entry.
3. Check existing `Unreleased` bullets first; merge/refine rather than duplicate.
4. Insert into the right subsection under `## Unreleased`, creating a subsection
   heading only if needed, keeping section order (Added, Changed, Fixed, Security).
5. Report a 1–3 sentence summary of what was added.

## Rules

- Only ever edit the `## Unreleased` section. Released sections (`## X.Y.Z`) are
  historical — never rewrite them.
- Never write a version number — `pnpm version` stamps `Unreleased` into a versioned
  section at release time.
- Edit the file and stop. Do not run `git commit` — suggest `/commit` afterward if the
  user wants the changelog update committed.
