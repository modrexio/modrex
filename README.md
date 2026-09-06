<div align="center">

<img src="assets/icon.png" width="96" alt="Modrex icon" />

# Modrex

**Install and manage game mods without opening the game folder.**

Modrex finds mods on ModWorkshop and Nexus Mods, installs them together with the loaders they
need, keeps your load order where you put it, and launches the game modded or vanilla.
Free and open source, for Windows and Linux.

[Download](#download) - [Documentation](https://modrex.net/docs/) - [Discord](https://discord.gg/tenzpx8JRM) - [Contributing](CONTRIBUTING.md)

[![Latest release](https://img.shields.io/github/v/release/modrexio/modrex?style=flat-square&label=release)](https://github.com/modrexio/modrex/releases/latest)
[![Downloads](https://img.shields.io/endpoint?url=https%3A%2F%2Fmodrex.net%2Fapi%2Fdownloads&style=flat-square)](https://github.com/modrexio/modrex/releases)
[![Windows and Linux](https://img.shields.io/badge/Windows%20%7C%20Linux-informational?style=flat-square)](#download)
[![Discord](https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/tenzpx8JRM)

<img src="assets/example.png" width="900" alt="The Modrex mod library showing installed mods for a game, each with a switch to enable or disable it" />

Supported today: **PAYDAY 3**, **PAYDAY 2**, **PAYDAY: The Heist**, **Crime Boss: Rockay City**
and **RAID: World War II**.

</div>

## What Modrex does

**Find mods without leaving the app.** Browse ModWorkshop for any supported game, and sign in to
Nexus Mods to browse that too wherever a game has both. Filter by category and tag, and read the
whole mod page: description, images, changelog, license, dependencies and credits.

**Install without unpacking anything.** Installing a mod is usually a single click. An archive
that holds several mods or an asset pack asks which parts you want, and one Modrex cannot place
on its own sends you to the mod page instead. When a mod needs a loader, such as SuperBLT or
UE4SS, Modrex installs that first. Missing dependencies are named and offered rather than
installed silently. You can drag archives from the file explorer onto the window, and Nexus
downloads arrive over `nxm://` when you use that site's Mod Manager Download button.

**Stay in control of your load order.** Group mods into nested folders, drag them into the order
the game should load them, disable one without deleting it, and launch modded or vanilla per
game.

**Know what you have installed.** Mods you dropped into the folder by hand are matched by
checksum against a mod index Modrex keeps current, so they show up with a real name and version
instead of as unknown files. Health Check sweeps the library for missing files, broken archives,
outdated installs, unrecognized mods and unmet dependencies, and can reinstall or fill in what it
finds.

Modrex keeps a separate game folder, launcher and launch options per game, and shows the active
game on your Discord profile. The interface is available in six languages.

## Download

**Windows**

```pwsh
winget install modrex
```

**Linux**

```sh
curl -fsSL https://modrex.net/install.sh | sh
```

Or take a specific package from the [latest release](https://github.com/modrexio/modrex/releases/latest):

| Platform       | Download                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| Windows        | [modrex_x86_64.exe](https://github.com/modrexio/modrex/releases/latest/download/modrex_x86_64.exe)           |
| Linux .deb     | [modrex_x86_64.deb](https://github.com/modrexio/modrex/releases/latest/download/modrex_x86_64.deb)           |
| Linux .rpm     | [modrex_x86_64.rpm](https://github.com/modrexio/modrex/releases/latest/download/modrex_x86_64.rpm)           |
| Linux AppImage | [modrex_x86_64.AppImage](https://github.com/modrexio/modrex/releases/latest/download/modrex_x86_64.AppImage) |

Modrex checks for updates and lets you install them from the app. An update installed that way is
cryptographically verified first; a package you download by hand is not checked for you. The
Windows installer is not Authenticode-signed, so SmartScreen may warn before it runs.

## Supported games

### Game support

| Game                    | <img src="assets/icons/steam.svg#gh-light-mode-only" width="16"><img src="assets/icons/steam-white.svg#gh-dark-mode-only" width="16"> Steam | <img src="assets/icons/epicgames.svg#gh-light-mode-only" width="16"><img src="assets/icons/epicgames-white.svg#gh-dark-mode-only" width="16"> Epic Games | <img src="assets/icons/xbox.svg#gh-light-mode-only" width="16"><img src="assets/icons/xbox-white.svg#gh-dark-mode-only" width="16"> Xbox App |
| ----------------------- | :-----------------------------------------------------------------------------------------------------------------------------------------: | :------------------------------------------------------------------------------------------------------------------------------------------------------: | :------------------------------------------------------------------------------------------------------------------------------------------: |
| PAYDAY 3                |                                            ![yes](https://img.shields.io/badge/Yes-brightgreen)                                             |                                                   ![yes](https://img.shields.io/badge/Yes-brightgreen)                                                   |                                             ![yes](https://img.shields.io/badge/Yes-brightgreen)                                             |
| PAYDAY 2                |                                            ![yes](https://img.shields.io/badge/Yes-brightgreen)                                             |                                                   ![yes](https://img.shields.io/badge/Yes-brightgreen)                                                   |                                                  ![no](https://img.shields.io/badge/No-red)                                                  |
| PAYDAY: The Heist       |                                            ![yes](https://img.shields.io/badge/Yes-brightgreen)                                             |                                                        ![no](https://img.shields.io/badge/No-red)                                                        |                                                  ![no](https://img.shields.io/badge/No-red)                                                  |
| Crime Boss: Rockay City |                                            ![yes](https://img.shields.io/badge/Yes-brightgreen)                                             |                                                   ![yes](https://img.shields.io/badge/Yes-brightgreen)                                                   |                                                  ![no](https://img.shields.io/badge/No-red)                                                  |
| RAID: World War II      |                                            ![yes](https://img.shields.io/badge/Yes-brightgreen)                                             |                                                        ![no](https://img.shields.io/badge/No-red)                                                        |                                                  ![no](https://img.shields.io/badge/No-red)                                                  |

### Launcher support

| Launcher                                                                                                                                                 | <img src="assets/icons/windows.svg#gh-light-mode-only" width="16"><img src="assets/icons/windows-white.svg#gh-dark-mode-only" width="16"> Windows | <img src="assets/icons/linux.svg#gh-light-mode-only" width="16"><img src="assets/icons/linux-white.svg#gh-dark-mode-only" width="16"> Linux |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | :-----------------------------------------------------------------------------------------------------------------------------------------------: | :-----------------------------------------------------------------------------------------------------------------------------------------: |
| <img src="assets/icons/steam.svg#gh-light-mode-only" width="16"><img src="assets/icons/steam-white.svg#gh-dark-mode-only" width="16"> Steam              |                                               ![yes](https://img.shields.io/badge/Yes-brightgreen)                                                |                                            ![yes](https://img.shields.io/badge/Yes-brightgreen)                                             |
| <img src="assets/icons/epicgames.svg#gh-light-mode-only" width="16"><img src="assets/icons/epicgames-white.svg#gh-dark-mode-only" width="16"> Epic Games |                                               ![yes](https://img.shields.io/badge/Yes-brightgreen)                                                |                                                 ![no](https://img.shields.io/badge/No-red)                                                  |
| <img src="assets/icons/xbox.svg#gh-light-mode-only" width="16"><img src="assets/icons/xbox-white.svg#gh-dark-mode-only" width="16"> Xbox App             |                                               ![yes](https://img.shields.io/badge/Yes-brightgreen)                                                |                                                 ![no](https://img.shields.io/badge/No-red)                                                  |

Adding a game is described in
[docs/contributing/adding-a-game.md](docs/contributing/adding-a-game.md).

## Troubleshooting

The full guide is at
[modrex.net/docs/troubleshooting](https://modrex.net/docs/troubleshooting/), covering game
detection, failed installs, loader problems and mods the game does not pick up.

If that does not solve it, open a
[bug report](https://github.com/modrexio/modrex/issues/new?template=bug_report.yml) and attach
your log. The log gives maintainers the details needed to diagnose the problem. Open it from
**Settings > Logs > Open log file**, or take it from disk if Modrex will not start:

| Platform | Path                                    |
| -------- | --------------------------------------- |
| Windows  | `%LOCALAPPDATA%\Modrex\logs\Modrex.log` |
| Linux    | `~/.local/share/modrex/logs/Modrex.log` |

## Privacy

Usage analytics are off unless you turn them on in Settings. Your Nexus Mods credentials are
stored on your device, in the operating system credential store where one is available.

The [privacy policy](https://modrex.net/privacy) covers what analytics contain if you opt in,
where credentials are stored on each platform and what happens when no credential store exists,
and which services Modrex contacts while you use it.

## Community and support

Ask questions, share mods and follow development in the
[Modrex Discord](https://discord.gg/tenzpx8JRM).

- [Request a feature](https://github.com/modrexio/modrex/issues/new?template=feature_request.yml)
- [Report a vulnerability](SECURITY.md), privately, never in an issue or in Discord
- [Contribute code or documentation](CONTRIBUTING.md)
- [Translate Modrex](TRANSLATING.md), which needs no development setup

<a href="https://discord.gg/tenzpx8JRM"><img src="https://discord.com/api/guilds/1508553766025170986/widget.png?style=banner3" alt="Modrex Discord server, member count and join link" /></a>

## Translations

Modrex is translated by the people who use it. The share below is the proportion of English
source keys that have target-language text; it does not measure quality, and a missing key falls
back to English in the app.

<!-- TRANSLATION_STATUS_START -->

<div align="center">

<!-- prettier-ignore -->
| Language | Translation | Contributors |
| --- | --- | --- |
| [English (en)](apps/desktop/src/renderer/src/i18n/en.json) | <img src="assets/i18n/status/en.svg" alt="English source: 460 valid strings."> Complete | - |
| [Deutsch (de)](apps/desktop/src/renderer/src/i18n/de.json) | <img src="assets/i18n/status/de.svg" alt="Deutsch (de): 456 accepted, 0 review, 4 missing; 99.1%."> 99.1% | [TarekLP](https://github.com/TarekLP) |
| [Italiano (it)](apps/desktop/src/renderer/src/i18n/it.json) | <img src="assets/i18n/status/it.svg" alt="Italiano (it): 424 accepted, 0 review, 36 missing; 92.2%."> 92.2% | [Enderbox89](https://github.com/Enderbox89) |
| [Русский (ru)](apps/desktop/src/renderer/src/i18n/ru.json) | <img src="assets/i18n/status/ru.svg" alt="Русский (ru): 424 accepted, 0 review, 36 missing; 92.2%."> 92.2% | [ShulhaOleh](https://github.com/ShulhaOleh) |
| [Українська (uk)](apps/desktop/src/renderer/src/i18n/uk.json) | <img src="assets/i18n/status/uk.svg" alt="Українська (uk): 424 accepted, 0 review, 36 missing; 92.2%."> 92.2% | [ShevRuslan1](https://github.com/ShevRuslan1) |
| [中文（中国） (zh-CN)](apps/desktop/src/renderer/src/i18n/zh-CN.json) | <img src="assets/i18n/status/zh-CN.svg" alt="中文（中国） (zh-CN): 456 accepted, 0 review, 4 missing; 99.1%."> 99.1% | [illianezheviasov](https://github.com/illianezheviasov) |

<div class="i18n-status-legend"><img src="assets/i18n/status/legend/accepted.svg" alt=""> Accepted <img src="assets/i18n/status/legend/review.svg" alt=""> Review <img src="assets/i18n/status/legend/missing.svg" alt=""> Missing</div>

</div>

To improve an existing language or add a new one, follow the
[translation guide](TRANSLATING.md).

<!-- TRANSLATION_STATUS_END -->

## License

Modrex is open source under the [MIT License](LICENSE).

## Support

If Modrex is useful to you, you can [sponsor its development](https://github.com/sponsors/modrexio)
or [buy a coffee](https://ko-fi.com/bipolyarus).
