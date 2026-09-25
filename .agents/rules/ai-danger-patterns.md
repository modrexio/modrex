# AI Danger Patterns

This repository allows AI-assisted work, but these five patterns are dangerous enough to block a change.

They are worse than cosmetic AI slop because they can hide bugs, break game-specific behavior, or make future maintenance harder.

## The five dangerous patterns

1. Silent catch / silent fallback
2. Generic helpers replacing game-specific logic
3. Defensive checks that hide broken invariants
4. Deep `if`/`else` nesting
5. Fake abstractions / speculative future-proofing

Before finishing any AI-assisted code change, check for all five.

---

## 1. Silent catch / silent fallback

Do not turn real failures into empty values.

Bad:

```ts
async function getInstalledMods() {
    try {
        return await api.getInstalledMods()
    } catch {
        return []
    }
}
```

This makes the UI show "no mods" when the real state is "failed to load mods".

Good:

```ts
async function getInstalledMods() {
    return await api.getInstalledMods()
}
```

Handle the error where useful feedback can be shown:

```ts
try {
    const mods = await getInstalledMods()
    setMods(mods)
} catch (error) {
    logger.error('Failed to load installed mods', { error })
    showErrorToast(t('mods.loadFailed'))
}
```

Allowed silent fallback cases are rare. The fallback must be a correct domain result, not a way to hide failure.

Examples of acceptable fallback:

- cache miss returns `undefined`
- optional thumbnail missing returns no thumbnail
- optional metadata missing follows a documented legacy path

Rule:

```md
Do not replace failures with empty values unless the empty value is a correct domain result.
```

---

## 2. Generic helpers replacing game-specific logic

Modrex has game-specific and loader-specific behavior. Do not replace it with generic helpers unless every existing invariant is preserved.

Bad:

```ts
function getModsPath(game: Game) {
    return path.join(game.path, 'Mods')
}
```

This looks clean but may be wrong for different games, loaders, stores, or legacy layouts.

Better:

```ts
function getCrimeBossModsPath(gamePath: string) {
    return path.join(gamePath, 'CrimeBoss', 'Mods')
}
```

Or preserve the existing domain dispatch:

```ts
function getInstallTarget(game: SupportedGame, loader: ModLoader) {
    switch (game) {
        case 'payday2':
            return getPayday2InstallTarget(loader)
        case 'payday3':
            return getPayday3InstallTarget(loader)
        case 'crimeboss':
            return getCrimeBossInstallTarget(loader)
    }
}
```

Rule:

```md
Do not replace game-specific, store-specific, loader-specific, or archive-specific behavior
with generic helpers unless all existing invariants are preserved.
```

---

## 3. Defensive checks that hide broken invariants

Validate at boundaries, not everywhere.

Boundary examples:

- user input
- filesystem paths
- archive contents
- network responses
- IPC command parameters
- deserialized state

Bad:

```ts
function renderInstalledMod(mod: InstalledMod | null | undefined) {
  if (!mod) return null
  if (!mod.name) return null
  return <InstalledModItem mod={mod} />
}
```

If the caller guarantees `InstalledMod`, this function should not pretend `null` is valid.

Good:

```ts
function renderInstalledMod(mod: InstalledMod) {
  return <InstalledModItem mod={mod} />
}
```

Rule:

```md
Do not add defensive checks inside trusted code paths. Fix the invariant or validate at the boundary.
```

---

## 4. Deep `if`/`else` nesting

Nested conditionals make AI code look safe while hiding the actual behavior.

Bad:

```ts
function installMod(mod: Mod | null) {
    if (mod) {
        if (mod.enabled) {
            if (mod.files.length > 0) {
                installFiles(mod.files)
            } else {
                throw new Error('Mod has no files')
            }
        }
    } else {
        throw new Error('Mod is missing')
    }
}
```

Good:

```ts
function installMod(mod: Mod | null) {
    if (!mod) throw new Error('Mod is missing')
    if (!mod.enabled) return
    if (mod.files.length === 0) throw new Error('Mod has no files')
    installFiles(mod.files)
}
```

Rules:

```md
Keep the happy path flat. Use guard clauses for invalid, unsupported, or exceptional cases.
Do not use `else` after `return`, `throw`, `continue`, or `break`.
```

---

## 5. Fake abstractions / speculative future-proofing

Do not add layers, helpers, options, or flags for hypothetical future use.

Bad:

```ts
function installMod(
  mod: Mod,
  options?: { dryRun?: boolean; force?: boolean; silent?: boolean }
) { ... }
```

Good:

```ts
function installMod(mod: Mod) { ... }
```

Extract a helper only when it:

- removes real duplication
- names a real domain concept
- isolates a real boundary

Rules:

```md
Do not add options, modes, flags, adapters, managers, factories, or helpers for hypothetical future use.
Extract a helper only when it removes real duplication, names a real domain concept, or isolates a real boundary.
```

---

## Final blocking checklist

A change should be blocked or revised if it introduces:

- [ ] silent `catch`
- [ ] fallback to `[]`, `{}`, `null`, `false`, or `""` that hides failure
- [ ] generic helper replacing game-specific logic
- [ ] validation inside trusted code that hides a broken invariant
- [ ] nested `if`/`else` pyramid
- [ ] `else` after `return` or `throw`
- [ ] new options or flags not needed by the current feature
- [ ] helper/manager/factory abstraction with only one real use
- [ ] broad `try/catch` without useful recovery or feedback
- [ ] code that is more generic than the actual product behavior
