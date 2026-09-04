# Integrations

An integration is a mod source, a mod loader, a storefront or a container format. Modrex
implements each one once, in shared Rust, and a game reaches it by declaring a binding in its
own `package.toml`.

That split decides which half of this page you need. If the mechanism already exists, you are
binding, and the work is data. If it does not, you are implementing, and the work is Rust plus a
new variant in the typed contract. A game is data only to the extent that everything it needs is
already implemented.

## Binding a game to an existing integration

Every binding lives in the game's manifest under `apps/desktop/src-tauri/src/games/<id>/`. The
field reference is [../reference/game-package.md](../reference/game-package.md).

**Sources.** `modworkshop` takes the numeric game id the site uses, as text. `nexus` takes both
the domain slug that the REST API and `nxm://` links use and the numeric id the content API
filters on, because Nexus names one game both ways. A game that declares no binding for a source
never mounts that source's browser.

**Loaders.** The `kind` selects a loader the host implements, and each kind accepts only the
configuration that loader reads. `modworkshop_ids` lists the mod pages the loader is published
under for this game, which is how a dependency on one of those pages is recognized as "install
the loader" rather than "install a mod". Leave it empty when the loader is hosted off site and
has no mod page.

**Stores.** `steam`, `epic` and `xbox`, each with the fields that storefront needs to find an
install.

**Decoders.** A container format that must be decoded before the archive readers see it. The
binding names the tag of the target its contents install into, and the validator rejects a tag
the manifest does not declare.

**News.** One reader per site, so the binding names only the category segment.

### When a binding fails

The diagnostics come from `game-package/src/validate.rs` and name the file. The ones specific to
bindings:

- two bindings from the same provider in one list
- a ModWorkshop game id that is not a number
- a loader kind declared twice
- a decoder routed to a target that does not exist
- a UE4SS loader missing a storefront, a proxy DLL or an `install_into` component

A binding that parses but points at the wrong remote id fails differently: the game builds and
runs, and its browser returns nothing. Check the id against the source's own page before
assuming the code is wrong.

## Implementing a new integration

This is shared host code plus a new variant in the contract. Both halves are needed: the variant
is how a manifest can name the mechanism, and the host code is what the mechanism does.

The contract lives in `apps/desktop/src-tauri/game-package/src/`. Its enums are internally
tagged with `deny_unknown_fields`, so a new variant is a new tagged shape rather than a set of
optional fields on an existing one. Three files move together:

- `lib.rs` holds the types. Add the variant and the fields that mechanism actually reads.
- `codegen.rs` turns a parsed package into the Rust literal the build script emits. Its printers
  destructure without rest patterns, so a new field stops the crate compiling until it is
  printed.
- `validate.rs` holds the checks serde cannot express, and `reference.rs` renders the field
  reference from exhaustive matches, so both stop compiling until the new variant is described.

Then the host side:

**A mod source.** `commands/sources.rs` owns `SOURCE_IDS` and resolves what each source calls a
game. The connector itself is its own module, as `commands/nexus.rs` is. A source that needs
authentication owns its own token handling; `commands/nexus_oauth.rs` is the worked example, and
`commands/secrets.rs` is the credential store it uses.

**A mod loader.** `commands/loaders.rs` holds `LOADER_REGISTRY`, where each entry pairs a
detection strategy with an install strategy. Detection answers whether the loader is already
present; installation either downloads from a canonical host or routes through the normal mod
install flow when every release is somebody's mod page.

**A storefront.** `commands/launchers/` holds one module per launcher behind the `Launcher`
trait in `types.rs`, and `all_launchers()` in `mod.rs` is the list. A launcher answers whether it
is installed, where a given game lives, and whether a path belongs to it. Platform-specific
detection is gated with `cfg`, and the non-Windows arm returns a real answer rather than
guessing.

**A container format.** The decoder is a module under `commands/mods/`, as `pdmod.rs` is, and
`commands/mods/zip.rs` selects it by extension before the generic archive readers run.

### What not to build

The contract is a closed set of typed mechanisms on purpose, and it should stay one.

A manifest declares data, never behavior. There are no executable callbacks, no expression
language and no per-game scripts, because a game package is parsed at build time and turned into
Rust literals, not evaluated at runtime.

Game directories hold a manifest and nothing else. Shared code does not import from a game
directory, and a game directory does not import from shared code.

There is no plugin loading. Adding a mechanism means adding a variant, which means the compiler
finds every place that has to handle it. That property is the reason the contract is closed, and
a runtime plugin surface would give it up in exchange for flexibility nothing currently needs.

Add a new mechanism when a real game needs behavior no existing variant expresses. Do not add
one to make a future game hypothetically easier.
