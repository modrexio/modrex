# Contributor documentation

This directory is for people working on Modrex. User instructions live on
[modrex.net/docs](https://modrex.net/docs/) and are not duplicated here.

| I want to                                                                  | Read                                                                         |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Add support for a game                                                     | [contributing/adding-a-game.md](contributing/adding-a-game.md)               |
| Point a game at a source, loader, storefront or decoder Modrex already has | [contributing/integrations.md](contributing/integrations.md), first section  |
| Add a source, loader, storefront or decoder Modrex does not have yet       | [contributing/integrations.md](contributing/integrations.md), second section |
| Look up a `package.toml` field                                             | [reference/game-package.md](reference/game-package.md)                       |
| Start from a working manifest                                              | [reference/package.example.toml](reference/package.example.toml)             |
| Understand how game packages are loaded                                    | [architecture/game-packages.md](architecture/game-packages.md)               |
| Know which URLs and artifacts outside clients depend on                    | [architecture/public-contracts.md](architecture/public-contracts.md)         |
| Set up the repository and run the checks                                   | [../CONTRIBUTING.md](../CONTRIBUTING.md)                                     |
| Translate Modrex                                                           | [../TRANSLATING.md](../TRANSLATING.md)                                       |
| Report a vulnerability                                                     | [../SECURITY.md](../SECURITY.md)                                             |

`reference/game-package.md` is generated from the Rust contract and CI fails when the committed
copy is stale. Everything else here is written by hand.

## Translated contributor documentation

There is none yet, and no directory is created for one until a translation exists. When one
does, it mirrors the English structure under `docs/i18n/<locale>/`, so English keeps its paths
and relative links inside a locale tree resolve.

GitHub serves Markdown files, not a documentation site: a page that a locale has not translated
is simply absent, and nothing redirects the reader to English. An index of translated pages
therefore links only files that exist.

A translated page records the commit of the English page it was translated from, so a reviewer
can see what has changed since.
