---
name: deslop
description: Remove AI-generated code slop from a diff, path, branch, or repository
---

# deslop

Use this skill to clean AI-shaped code before a commit, PR, or final answer.

Start with the five dangerous patterns from `AI_DANGER_PATTERNS.md`. These are worse than cosmetic slop because they can hide real bugs.

## Mode

Determine the target based on the argument passed:

- **No argument** — scan uncommitted changes only (`git diff HEAD`)
- **Path argument** (e.g. `apps/desktop/src/renderer/`) — scan that path only
- **`--diff`** — scan the diff of the current branch against main (`git diff main...HEAD`)
- **`--all`** — scan the full codebase (`apps/desktop/src/` and
  `apps/desktop/src-tauri/src/`)

Fix each issue you find, then report a 1-3 sentence summary of what you changed.

## Required reads

Before editing, read:

1. `AI_DANGER_PATTERNS.md`
2. the repository-root `AGENTS.md`
3. the nearest `AGENTS.md` above each touched path

## Priority order

Fix dangerous AI patterns first:

1. Silent catch / silent fallback
2. Generic helpers replacing game-specific logic
3. Defensive checks that hide broken invariants
4. Deep `if`/`else` nesting
5. Fake abstractions / speculative future-proofing

Then clean cosmetic AI slop:

- comments explaining what the code already says
- casts to `any` to work around type issues — fix the types instead
- unnecessary `useCallback` or `useMemo`
- derived state stored in React state without reason
- renamed `_unused` variables that should just be removed
- comments like `// removed`, `// old`, `// TODO: maybe later` without an issue
- unrelated formatting or file churn
- non-standard symbols in comments or strings (`→`, `←`, `⇒`, `✓`, `✗`) — use plain words: "to", "becomes", "returns", "yes", "no"

## Silent catch / fallback cleanup

Replace silent failure with either:

- no local catch, letting the caller handle it
- a catch that adds context and shows useful feedback
- a documented domain fallback

Bad:

```ts
try {
  return await api.getInstalledMods()
} catch {
  return []
}
```

Better:

```ts
return await api.getInstalledMods()
```

or:

```ts
try {
  return await api.getInstalledMods()
} catch (error) {
  logger.error("Failed to load installed mods", { error })
  throw error
}
```

## Generic helper cleanup

Do not simplify domain-specific code into generic helpers.

If a helper hides game-specific behavior, restore explicit domain branching or rename it to the real domain rule.

## Defensive check cleanup

Remove impossible-state checks from trusted code.

Do not widen types to include `null` or `undefined` unless the domain really allows it.

Validate at boundaries instead.

## Control-flow cleanup

Flatten nested conditions. Use guard clauses and early returns. Remove `else` after `return`, `throw`, `continue`, or `break`.

## Abstraction cleanup

Delete future-facing options, flags, helpers, managers, factories, and adapters unless they are needed by current behavior.

Inline one-use helpers when they do not name a real domain concept.

## Structural comment protection

Do not remove useful file-level or section-level comments.

Keep comments that explain: reference implementations, file formats, algorithm provenance, archive format behavior, security-sensitive path assumptions, game-specific loader rules, why a port must remain byte-compatible, test scenario intent.

The structural comments in `pdmod.rs` (`.pdmod` format description, Bob Jenkins hash provenance, hashlist reference) are load-bearing domain knowledge — never remove them.

Only remove comments that repeat nearby code or describe basic syntax.

## Project-specific violations

Fix these when found:

- hardcoded Tailwind color classes (`zinc-*`, `red-*`, `gray-*`) — use semantic tokens from `src/renderer/src/index.css`
- bare `ReactMarkdown` — use `components/MarkdownContent.tsx`
- native `<select>` — use `components/Select.tsx`
- bare string literals in JSX — use `t('key')` from `../i18n`
- direct `api.getMod`, `api.listModFiles`, or `api.listModLinks` calls in renderer components — use `getCachedMod`, `getCachedModFiles`, or `getCachedModLinks`
- direct `api.getThumbnail` calls — use `getLocalThumbnail` or `getCachedThumbnailUrl`
- new Tauri commands not wired in all three required places: Rust implementation, `generate_handler![...]`, and `src/renderer/src/api.ts`
- debug `console.log` or `console.warn`

## Procedure

1. Inspect the target diff or files.
2. Fix the five dangerous patterns first.
3. Fix remaining AI-shaped code.
4. Do not change behavior unless the slop is itself a bug.
5. Run the narrowest useful check if available.
6. Report what was cleaned in 1-3 sentences.

## Stop conditions

Stop and ask for direction only if cleanup would require a behavior decision.

Do not ask before removing obvious comments, flattening obvious control flow, or deleting unrelated generated noise.
