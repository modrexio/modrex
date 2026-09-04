# Game packages

A supported game is a directory holding one `package.toml`. The manifest declares what the game
is and how mods behave in it; the shared Rust code decides what to do about that. Nothing in the
desktop backend enumerates the games, so adding one that fits existing mechanisms is a new
directory and nothing else.

## Discovery

`apps/desktop/src-tauri/build.rs` reads every directory under `src/games/`. For each one it
requires a `package.toml`, parses it into `GamePackage` with serde, runs `validate::check`
against the directory name, and writes the whole set into `OUT_DIR` as a Rust function returning
typed literals. `src/games/mod.rs` includes that file and caches the result in a `LazyLock`.

Two consequences follow from doing this at build time rather than at startup:

- A malformed manifest is a compilation failure naming the file and the problem, not a game
  that silently fails to appear.
- No TOML parser ships in the binary. The application carries the packages as typed data.

The build script re-runs when the games directory or any manifest changes.

## The contract

`apps/desktop/src-tauri/game-package/` is a separate crate that owns the types and nothing else.
It is the single definition of what a manifest may say, and four files keep each other honest:

- `lib.rs` holds the types. The enums are internally tagged with `deny_unknown_fields`, so a
  mechanism is a tagged variant carrying exactly the fields that mechanism reads, rather than an
  open struct of optional fields that may or may not apply.
- `codegen.rs` prints a parsed package as a Rust literal. Every printer destructures without a
  rest pattern, so a field added to the contract stops the crate compiling until it is printed.
- `validate.rs` holds the rules serde cannot express: agreement between a package and its
  directory, uniqueness within a list, references between sections, and values that would build
  a path the scan cannot find.
- `reference.rs` renders the contributor reference from exhaustive matches, so a new provider,
  loader, policy or mode stops the crate compiling until it is documented.

The result is that extending the contract is mechanical. The compiler lists the places that have
to handle a new variant, and none of them can be forgotten.

## What the packages produce

Two generated artifacts, both committed and both gated in CI:

- **The Rust registry** in `OUT_DIR`, consumed through `src/games/mod.rs`.
- **`packages/games/catalog.generated.ts`**, written by a test in `src/games/catalog.rs`. It is
  what the renderer and the site read, so the same facts reach TypeScript without being restated
  there. A game with no ModWorkshop binding has no workshop id in the catalog, and the field is
  absent rather than zero, so a consumer cannot read "not listed there" as an id.

`docs/reference/game-package.md` is generated the same way, from the contract rather than from
the packages.

## The adapter

`commands/games.rs` is the one place that turns a package into the shapes the rest of the
backend already reads: `ModEngineConfig`, `ScanTarget` and `GameDef`. It is a translation, not a
copy. Marker rules fan out into the flat per-mode lists the scan reads, an `ignore_preset`
expands into the host's own name list, the disabled folder is derived from the target path, and
a target's label becomes the key the renderer looks up in `settings.folders`.

Keeping the translation in one function is what lets the manifest describe a game in the game's
own terms while the scan, install and launch paths keep reading the shapes they were written
against.

## Where the line sits

Declarative game data on one side, shared host behavior on the other.

A manifest names mechanisms; it does not implement them. It cannot carry a callback, an
expression or a script, because it is parsed at build time and turned into literals, never
evaluated. A game directory holds a manifest and nothing else: shared code does not import from
a game directory, and a game directory does not import from shared code.

A game reaches a source, loader, storefront or container format only by declaring a binding for
one the host implements. That is why a game absent from ModWorkshop never mounts the ModWorkshop
browser, and why a manifest cannot name a loader that does not exist or attach configuration a
loader does not read.

## Adding a mechanism

A new typed variant is justified when a real game needs behavior no existing variant expresses,
and the behavior belongs to the host rather than to that one game. Adding it means touching the
four contract files and the host code that implements it, and the compiler finds the rest.

It is not justified as preparation. An option, a flag or a variant added for a game that does
not exist yet is a shape nobody has validated against reality, and the closed contract is worth
more than the head start.

Runtime plugin loading is deliberately absent for the same reason. The value of the contract is
that every mechanism is known at compile time and every consumer of it is found by the compiler.
A plugin surface trades that for flexibility nothing currently needs.
