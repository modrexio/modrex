---
name: control-flow
description: Flatten nested conditionals and make the happy path readable
---

# control-flow

Use this skill when a change touches branching logic, validation, installation flow, filesystem routing, renderer event handlers, or any function with nested conditionals.

This skill targets dangerous pattern #4 from `.agents/rules/ai-danger-patterns.md`: deep `if`/`else` nesting.

## Rule

The happy path should not be buried.

Invalid, unsupported, or exceptional cases should exit early.

## Required checks

Look for:

- nested `if`/`else` blocks
- `else` after `return`, `throw`, `continue`, or `break`
- repeated checks for the same condition
- validation mixed with business logic
- side effects hidden inside deep branches
- boolean expressions that need a name

## Refactoring order

Try these in order:

1. invert the condition and return early
2. remove `else` after terminal statements
3. extract a named boolean
4. extract a small helper only when it names a real domain concept
5. split the workflow into smaller functions
6. use `switch` for many exclusive domain cases

## Examples

Bad:

```ts
if (game.isInstalled) {
  if (game.supportsMods) {
    if (!game.isRunning) {
      installMod(mod)
    }
  }
}
```

Good:

```ts
if (!game.isInstalled) return
if (!game.supportsMods) return
if (game.isRunning) return
installMod(mod)
```

Bad:

```ts
if (!gamePath) {
  return null
} else {
  return scanGame(gamePath)
}
```

Good:

```ts
if (!gamePath) return null
return scanGame(gamePath)
```

## Preserve behavior

Do not change behavior while flattening code.

Before editing, identify which branches return early, throw, mutate state, write files, call APIs, or show UI feedback. After editing, ensure those effects still happen under the same conditions.

## Warning

Do not fix nesting by creating a fake abstraction.

Bad:

```ts
function validateGameState(game: Game) {
  return game.isInstalled && game.supportsMods && !game.isRunning
}
```

Only good if `validateGameState` is a real reused domain rule. Otherwise use a named boolean inline.

## Report

After editing, report:

- which function or file was flattened
- whether behavior was preserved
- which check was run, if any
