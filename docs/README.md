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
| Know who may change a translation file, and which check enforces it        | [architecture/i18n-ownership.md](architecture/i18n-ownership.md)             |
| Set up the repository and run the checks                                   | [../CONTRIBUTING.md](../CONTRIBUTING.md)                                     |
| Review the desktop interface in a browser                                  | [contributing/preview.md](contributing/preview.md)                           |
| Translate Modrex                                                           | [contributing/translating.md](contributing/translating.md)                   |
| Report a vulnerability                                                     | [../SECURITY.md](../SECURITY.md)                                             |

`reference/game-package.md` is generated from the Rust contract and CI fails when the committed
copy is stale. Everything else here is written by hand.
