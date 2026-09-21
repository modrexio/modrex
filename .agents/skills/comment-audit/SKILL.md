---
name: comment-audit
description: Review comments against the Comments policy in AGENTS.md and fix violations
---

# comment-audit

Use this skill after AI-assisted edits, or on demand to review existing code. It enforces the Comments section of the repository-root `AGENTS.md`.

This skill handles cosmetic AI slop. It is lower priority than the five dangerous patterns in `AI_DANGER_PATTERNS.md`.

## Scope

- No argument: audit comments added or modified in uncommitted changes.
- A file or directory path: audit every comment in that scope.
- `--all`: audit a whole workspace app, one directory at a time, reporting per file.

When invoked on existing code (a path or `--all`), fix violations directly but change nothing except comments. Never touch code while running this skill.

## Delete comments that explain what

Delete comments that narrate code.

Bad:

```ts
// Get enabled mods
const enabledMods = mods.filter((mod) => mod.enabled)
```

Bad:

```ts
// Loop through files
for (const file of files) {
  installFile(file)
}
```

Bad:

```rust
// Return Ok result
Ok(result)
```

## Enforce the default shape

The default comment is one to four lines stating the constraint and what breaks without it. For anything longer, first check the reserved kinds below. Everything else gets compressed to its operative constraint. The full argument and the history live in git, not in the file.

Bad (an essay where a constraint would do):

```rust
// Backfill remote_id before upgrade_negative_ids runs. Ids used to be real
// modworkshop ids, so entries identified before remote_id existed still carry
// the real id in the id field. upgrade_negative_ids cannot tell "never
// identified" apart from "identified before this field existed", and its
// fuzzy name fallback clears the stored version and marks the mod Outdated,
// which would fire en masse for every pre-existing install as a side effect
// of this migration rather than a real update.
```

Good:

```rust
// Must run before upgrade_negative_ids: it cannot tell "never identified"
// from "identified before remote_id existed", and its name fallback would
// mass-mark pre-existing installs Outdated during a plain data migration.
```

## Delete history

A comment describes the present code, never the change that produced it. Remove change narration: "previously", "used to", "no longer", "anymore", "renamed from", "the old version". If part of the text states a real present-tense constraint, keep only that part. The change story belongs in the commit message and is already in git history.

## Plain prose punctuation

Contributors read comments as raw source, where markup renders as noise. Rewrite:

- backticks around identifiers: write save_state, not `save_state`
- semicolons chaining clauses: split into sentences
- arrows and dashes used as separators: use commas, periods, or parentheses
- any non-ASCII character, including em dashes

## One home per fact

- A fact enforced by a check script or test: the comment shrinks to one line naming the enforcement.
- A fact stated both inline and in an AGENTS.md: the inline comment at the site is canonical. Keep it, and reduce the other copy to a pointer when editing that file.
- Never resolve duplication by deleting the site comment.

## Keep comments that explain why

Keep or improve comments that explain:

- ModWorkshop or Nexus API quirks
- archive format quirks or structure
- game-specific loader behavior
- filesystem layout invariants
- state migration reasons
- path traversal or security constraints
- compatibility decisions
- cleanup or rollback rules
- user-visible behavior that future edits must preserve
- reference implementations
- algorithm provenance
- section headers in long or domain-heavy files
- public function behavior
- test scenario intent

Good:

```ts
// ModWorkshop can return duplicate files for archived mod versions,
// so dedupe by download URL before writing to disk.
const uniqueFiles = dedupeByUrl(files)
```

Good:

```rust
// Use remove_dir, not remove_dir_all, so a failed backup restore
// cannot silently delete user mods.
fs::remove_dir(path)?;
```

## Preserve structural comments

Do not delete comments that act as section headers or file-level orientation, and do not compress the reserved kinds: file formats, wire protocols, algorithm provenance, security assumptions. These stay as long as they need to be.

Examples to keep:

```rust
// Reference implementation: https://github.com/HW12Dev/PDModExtractor (MIT)
```

```rust
// .pdmod is a password-protected ZIP containing pdmod.json (ItemQueue manifest)
// plus the replacement asset files. BundlePath and BundleExtension are hashes,
// and the hashlist maps them back to game-relative asset paths.
```

```rust
// Bob Jenkins lookup8 hash, direct port of hash.cpp from PDModExtractor.
```

These preserve domain knowledge and make complex files safer to edit. Do not "clean up" structural comments just because they are comments.

## No placeholder comments

Remove:

- `// TODO` without a concrete issue or next step
- `// FIXME` without a reason
- `// old`, `// removed`, `// legacy` when the code already shows it
- commented-out code
- comments explaining a previous failed attempt

## Procedure

1. Establish scope (see Scope).
2. Delete comments that repeat code, narrate history, or hold placeholders.
3. Compress blocks over four lines that are not a reserved kind.
4. Rewrite punctuation violations as plain sentences.
5. Shrink comments duplicating a check script, test, or AGENTS.md per the one-home rule.
6. If a comment compensates for unclear code, flag it in the report instead of editing the code.

## Report

Report counts per category (deleted, compressed, rewritten for punctuation, deduplicated) and mention any important comments deliberately kept, plus any spots where the real fix is a rename or restructure.
