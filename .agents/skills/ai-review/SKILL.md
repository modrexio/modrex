---
name: ai-review
description: Review a diff for AI-shaped code before a PR, commit, or final summary
---

# ai-review

Use this skill before proposing a PR, commit, or final response for a non-trivial code change.

Start with blocker-level issues from `AI_DANGER_PATTERNS.md`.

## Review target

Default to `git diff HEAD`.

If the user provides a path or range, review only that target.

## Blocker checklist

Check first for the five dangerous AI patterns:

1. Silent catch / silent fallback
2. Generic helpers replacing game-specific logic
3. Defensive checks that hide broken invariants
4. Deep `if`/`else` nesting
5. Fake abstractions / speculative future-proofing

## Cleanup checklist

Then check for:

- obvious WHAT-comments
- useful structural/header comments wrongly removed
- `any` casts
- unnecessary `useMemo` or `useCallback`
- derived data stored in React state
- unrelated formatting
- hardcoded renderer colors (use semantic tokens from `index.css`)
- direct API calls that bypass project caches (`modCache.ts`, `thumbnailCache.ts`)
- bare JSX strings (use `t('key')`)
- missing Tauri command wiring (all three places)
- user-facing behavior missing from CHANGELOG when appropriate
- code that contradicts the nearest `AGENTS.md` above it

## Severity

Use three levels:

- **Blocker**: dangerous AI pattern, likely bug, broken invariant, wrong project pattern, unsafe filesystem/archive behavior.
- **Cleanup**: maintainability issue, obvious AI-shaped code, useless comment, unnecessary abstraction.
- **Note**: acceptable but worth mentioning.

## Output

Return:

1. Blockers
2. Cleanups
3. Notes
4. Suggested next command or skill

If there are no issues:

```md
Diff is clean against the ai-review checklist.
```

Do not invent problems. Cite the exact file and function when possible.
