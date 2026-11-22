---
name: changelog
description: Write or update .changes/ files for user-facing changes
---

# changelog

Record changes that haven't been recorded yet as files in [`.changes/`](../../../.changes/).
The file format, the optional `prs` and `thanks` lines, and how PR links and author credit are
derived are in [docs/contributing/changelog.md](../../../docs/contributing/changelog.md); read it
first. Never edit `CHANGELOG.md`: `bun release` builds each version's section from the files.

## Scope

Determine which changes to record based on the argument passed:

- **No argument** — find the last tag (`git describe --tags --abbrev=0`) and read
  `git log <tag>..HEAD` (full messages, not just subjects). Compare against the files
  already in `.changes/` and add only what's missing — safe to re-run after every change.
- **A ref or range** (e.g. `HEAD~3..HEAD`, a single SHA) — read exactly that range
  (`git log <range>`, `git show <sha>`).
- **Uncommitted changes** — if there's nothing new in the commit log but `git status`
  shows a dirty tree, read `git diff HEAD` instead.

Read full commit messages and diffs, not just subject lines — a one-line `fix:` subject
often hides the user-facing detail worth recording (or reveals it's purely internal).

## Categorization

The `category` line takes a [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) section:
`added`, `changed`, `fixed`, `security` (use `deprecated` / `removed` only if genuinely
applicable).

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

- One file per user-facing change, in product voice, past tense: "Added X.", "Fixed Y
  appearing when Z.", not commit subjects, hashes, scopes, or issue numbers. No list
  marker, PR number or name in the text; the notes add the links and credit.
- If several commits implement one feature or fix, write a single file — the changelog
  reflects shipped behavior, not commit-by-commit history.
- If a commit fixes something an unreleased file already describes (the buggy behavior
  was never released), edit that file instead of adding a separate `fixed` file for code
  users never saw broken. The edit also links the fixing PR to that entry.
- If a commit adds a sub-detail to an unreleased feature (e.g. a progress counter
  added to a modal that itself hasn't shipped), fold it into that feature's file —
  never add a separate entry for behavior users haven't seen without it.
- Set `prs` only when the PR that creates or edits the file is not the one the change
  came from, such as an entry written after its PR merged.
- Keep entries short. Don't describe a feature's internal contents unless the detail
  is itself the user-facing point — "Added a per-mod options menu." is enough; listing
  what's inside the menu is not.
- No Unicode arrows/symbols — plain words ("becomes", "to", "via").
- Match the tone already in `CHANGELOG.md`'s released sections — read a couple before
  writing new ones.

## Procedure

1. Resolve scope (see above) and read the actual diffs, not just messages.
2. If nothing in scope is user-facing, say so and stop — do not invent an entry.
3. Check the existing `.changes/` files first; merge/refine rather than duplicate.
4. Write `.changes/<short-slug>.md` named after the change, or edit the existing file.
5. Run `bun check-changes`.
6. Report a 1–3 sentence summary of what was added.

## Rules

- Only ever write or edit `.changes/` files. Released sections of `CHANGELOG.md`
  (`## X.Y.Z`) are historical — never rewrite them, and never add an Unreleased section.
- Never write a version number — `bun release` turns the files into a versioned section.
- Edit the files and stop. Do not run `git commit` — suggest `/commit` afterward if the
  user wants the changelog update committed.
