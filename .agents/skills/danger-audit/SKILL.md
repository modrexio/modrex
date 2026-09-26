---
name: danger-audit
description: Audit a diff for the five dangerous AI patterns
---

# danger-audit

Use this skill before finishing any non-trivial AI-assisted code change.

These patterns can hide bugs or break Modrex-specific behavior. They are stricter than a general style review.

## Target

Default to `git diff HEAD`.

If the user provides a path, branch, or file, audit that target.

## The five blockers

A change is not ready if it introduces one of these without a strong project-specific reason:

1. Silent catch / silent fallback
2. Generic helpers replacing game-specific logic
3. Defensive checks that hide broken invariants
4. Deep `if`/`else` nesting
5. Fake abstractions / speculative future-proofing

Read `.agents/rules/ai-danger-patterns.md` for full examples.

---

## 1. Silent catch / silent fallback

Block:

```ts
catch { return }
catch { return [] }
return data ?? []  // when this hides a failed load, parse, or install
```

Ask:

- Is the fallback a correct domain result?
- Would this make the UI lie?
- Would this hide a filesystem, IPC, archive, or network failure?
- Can the caller show a useful error instead?

Accept only when the fallback is genuinely optional (missing thumbnail, cache miss).

---

## 2. Generic helpers replacing game-specific logic

Block helpers that collapse game-specific behavior into generic behavior.

Danger signs:

- function names like `getModsPath`, `getGamePath`, `processGame`, `handleLoader`
- helpers that assume all games use the same `Mods` convention
- removal of explicit `payday2`, `payday3`, `pdth`, or `crimeboss` branching
- "cleanup" that makes code shorter by deleting domain cases

Ask:

- Which game-specific invariants existed before?
- Are all loaders still handled?
- Are Steam, Epic, Xbox, and legacy layouts still handled where relevant?

---

## 3. Defensive checks hiding broken invariants

Block defensive checks inside trusted code paths.

Danger signs:

- changing `InstalledMod` to `InstalledMod | null | undefined`
- returning `null` instead of fixing the caller
- `if (!value) return` deep inside business logic
- optional chaining added everywhere
- `?? ""`, `?? []`, `?? false` used to silence type errors

Ask:

- Is this value allowed to be missing by design?
- Should this be validated at a boundary instead?
- Is the type wrong?

---

## 4. Deep `if`/`else` nesting

Block new nested pyramids.

Danger signs:

- more than two levels of `if`
- `else` after `return`, `throw`, `continue`, or `break`
- happy path indented inside validation branches
- side effects hidden inside nested branches

Fix with: guard clauses, early returns, named booleans, smaller functions, `switch` for exclusive domain cases.

---

## 5. Fake abstractions / speculative future-proofing

Block abstractions that are not needed now.

Danger signs:

- `Manager`, `Service`, `Factory`, `Adapter`, `Strategy`, `Handler` added for one use
- options like `dryRun`, `force`, `silent`, `experimental`, `mode`
- new layers around existing direct code
- broad interfaces with one implementation

Ask:

- Does this remove real duplication?
- Does this name a real domain concept?
- Would inline code be clearer?

---

## Output format

```md
## Danger audit

### Blockers
- ...

### Cleanups
- ...

### Accepted
- ...

### Recommended next step
...
```

If clean:

```md
## Danger audit

No blocker-level AI danger patterns found.
```
