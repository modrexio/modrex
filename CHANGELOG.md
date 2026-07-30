# Changelog

All notable changes to Modrex are documented in this file. Each version's section here becomes the GitHub release body and the in-app update notes — entries should read as user-facing release notes, not commit messages.

## Unreleased

### Added

- Added Nexus Mods as a second mod source for PAYDAY 3, PAYDAY 2, PAYDAY: The Heist, and Crime Boss: Rockay City. Browse and install through OAuth sign-in and website mod-manager downloads, choosing between ModWorkshop and Nexus Mods from the top of the Browse page.
- Unrecognized Nexus mods can now be identified by matching them against Nexus's own listings: dragged-in archives at drop time, and already-installed mods automatically or on demand from a mod's options menu.
- New About tab in Settings with project info and quick links to the GitHub repository, GitHub Sponsors, Discord, and modrex.net.
- A one-time banner asking for a GitHub star, shown once ever after the 10th successful mod install (and at least a week of use). Dismissing it is permanent.
- Added support for RAID: World War II: browse, install, and manage its mods (SuperBLT and legacy RaidBLT script mods plus asset override packs, all installed into the game's `mods` folder as the current loader expects), with one-click install and dependency detection for the RAID-SuperBLT mod loader.
- Browse now lets you filter mods by tag, choosing tags to include or exclude.
- New Storage section in Settings to clear cached data and reset app settings to defaults.
- New buttons in Settings to open the game folder, each of its mod folders, and Modrex's data and install folders.
- Mods can now be installed by dragging files from the file explorer into the window.
- Added a Language setting for the app's interface: English and Russian.

### Changed

- Loading placeholders now use one consistent design across mod cards, mod details, galleries, downloads, formatted text, and the Settings page.
- Replaced the native title bar with a custom one, unified across all platforms.
- Improved app startup time.
- Redesigned the startup screen as a compact window with loading progress.
- Mod licenses now show as their own tab on the mod page with full formatting.
- Redesigned the mod page:
  - Mod details (downloads, likes, views, version, dates, and links) moved into an info panel that stays visible while you scroll.
  - The panel now credits everyone who worked on the mod, with avatars and roles, not just the author. Clicking a person opens their ModWorkshop profile.
  - Each contributor with a donation link gets their own donation button, labeled with where it leads (PayPal, Ko-fi, GitHub Sponsors, and more).
  - Mods with a public repository get a Repository row showing where the code is hosted (GitHub, GitLab, or Bitbucket), replacing the plain "Source" link.
  - Banners keep the same proportions as on ModWorkshop instead of being cropped to a fixed height.
  - Descriptions and dependency lists use the full page width.
- The Dependencies & Instructions tab now lists dependencies in the author's intended install order, numbered, with instructions below.

### Fixed

- Fixed popup windows resizing and shifting position as their contents changed, most noticeably when switching tabs in the mod health check.
- Fixed the download progress bar sometimes remaining visible after a mod finished installing.
- Fixed the game picker's "Installed only" filter sometimes hiding installed games.
- Fixed installed mods not being recognized on slower internet connections, where the mod identification data could time out before it finished downloading.
- Fixed a rare case where an interrupted background update left the mod identification data unreadable, keeping installed mods unrecognized until the next refresh.
- Fixed the Settings > Game tab's launcher selector staying disabled with no explanation while launcher detection was still running in the background; it now shows a detecting indicator instead.
- Fixed mods whose names contain characters such as `%` or `_` not being recognized by name.
- Fixed the app not remembering which tab you were on after switching games.
- Fixed the analytics consent prompt not appearing on first launch until a game was selected.
- Fixed the game picker still acting on the previously selected game, which could show a game-specific notice or the wrong Discord status while no game was chosen.
- Fixed mod cards varying in height depending on their title and description length, which made grid rows uneven across Browse and Installed.
- Fixed installing multiple files from one archive keeping only the last selected file, as each file's install removed the previously installed one.
- Fixed an empty duplicate folder appearing next to a mod's card when the mod's files span that folder and the top level.
- Fixed PAYDAY: The Heist reporting every mod loader dependency as missing in the health check, which checked for PAYDAY 2's SuperBLT instead of PDTH's own loaders.
- Fixed a mod loader showing as installed immediately after installing it while installing the mod still reported it missing. Loader status is now re-checked against the game folder instead of assumed, which also corrects PAYDAY 2's Diesel 3.0 branch, where SuperBLT cannot work even when its file is present.
- Fixed dependencies that need a manual choice, such as picking from a multi-file archive, doing nothing when installed from a mod's Dependencies tab. They now explain that the dependency has to be installed from its own mod page.
- Fixed overlapping operations on the same game, such as a download finishing while the mod list refreshed, being able to discard each other's changes to the installed mod list.
- Fixed the "mods are hidden" warning sometimes never clearing after launching PAYDAY 2 or PAYDAY: The Heist without mods.
- Fixed the Launch and Launch Modded buttons showing in Settings when it was opened without a game selected.
- Fixed several dialogs missing a close button in the top corner, so every dialog can now be closed with an X.
- Fixed the Linux app not having a proper icon in the taskbar, application menu, and window switcher.
- Fixed dragged-in downloaded archives being named after the download's filename instead of the mod's real name.

### Security

- Prevented external URL query parameters from being reinterpreted as Windows shell commands.
- Hardened thumbnail caching to reject unsafe image filenames.
- Mod descriptions are now sanitized before rendering: scripts, event handlers, and unsafe HTML from mod pages are stripped, while formatting, images, colored text, and video embeds keep working.
- Prevented maliciously crafted color tags in mod descriptions from stalling the app.

## 0.12.2

### Changed

- Game detection now skips store launchers that aren't installed and logs each probe, making startup hangs diagnosable from the log.

### Fixed

- Fixed the app freezing at startup ("Modrex is not responding") when game detection hit a disconnected network drive, card reader, or stuck Windows service.
- Fixed Xbox game detection not finding games installed on drive letters beyond G:.

## 0.12.1

### Added

- Added a notice when PAYDAY 2's Diesel 3.0 beta is detected, pointing to the community SuperBLT port.

### Fixed

- Fixed PAYDAY 2 not being detected after the Diesel 3.0 beta update, which renamed the game executable.
- Fixed the app not restoring to the game picker on relaunch when it was the last active view before closing.

## 0.12.0

### Added

- Added support for `.pdmod`.
- Added Discord Rich Presence showing the active game on profile.
- Added a Health Check on the Installed page, scans all mods and groups issues by category, with bulk actions to fix them:
  - Missing files
  - Broken archives
  - Outdated installs
  - Unrecognized mods
  - Missing dependencies
  - Available updates
- Added Settings access from the Game Picker Window.
- Added an "Outdated" badge in Manage Files for leftover duplicate files left behind when a mod's download switched between a plain file and an archive.
- Install button on Browse Mods now shows download percentage and a progress bar while a mod is downloading.
- Loading screen now shows how many mods have been scanned during the identification phase.
- "Update All" button now shows progress counter during a batch update.
- Added a per-mod options menu on installed mod cards.
- Added a clear button to the game picker search field.
- Missing-dependencies dialog now shows download progress on install buttons, lets you open a dependency's detail page by clicking its row, and adds an "Install all" button when multiple dependencies can be auto-installed.

### Changed

- Settings is now organized into three tabs.
- Release artifact filenames now include an architecture suffix (`modrex_x86_64.exe`, `modrex_x86_64.deb`, `modrex_x86_64.rpm`, `modrex_x86_64.AppImage`).

### Fixed

- Fixed the missing-dependency warning not appearing when installing a mod that has multiple downloadable files.
- Fixed updates not being detected for mods whose download switched between a plain file and an archive, which could leave an old copy installed alongside the new one.
- Fixed Settings remembering the wrong tab when switching between the game picker's global settings and per-game settings.
- Fixed ghost buttons and navigation tabs showing no hover feedback, making their click targets unclear.
- Fixed Browse Mods page numbers disappearing briefly when changing the search, sort, or category filter.
- Fixed old Browse Mods results briefly flashing when changing filters before the new page loaded.
- Fixed download progress stopping to update when switching away from the mod detail page and back during a download.
- Fixed updating a mod resetting it to enabled even if it was disabled before the update.
- Fixed a mod card on Browse Mods becoming permanently frozen in a loading state after updating it from the Installed page.
- Fixed Crime Boss mods that default to disabled in-game being impossible to enable from Modrex after the game created their settings file on first launch.
- Fixed the Update window still prompting to pick files for multi-pak mods when the mod author renamed the archive entries between versions.

## 0.11.1

### Added

- Added an Xbox PAYDAY 3 setting to remove BugSplat crash reporter files before launch.

### Fixed

- Fixed updating multi-pak mods unnecessarily re-prompting to pick files instead of reinstalling the previously selected ones, and fixed "Update All" stalling until manually resumed whenever that prompt did appear.

## 0.11.0

### Added

- Added an in-app News tab per game.
- Added Crime Boss: Rockay City support.
- Added search and an installed-only filter to the game picker.
- Added UE4SS support.

### Changed

- Improved modworkshop API request performance and pacing.

### Fixed

- Fixed empty Installed folders disappearing after their last mod was uninstalled.
- Fixed mods that ship separate .ucas/.utoc data files alongside their .pak.
- Fixed mods staying permanently unrecognized after a missed identification.
- Fixed a redundant leading "v" before mod versions in dependency and update lists.

## 0.10.0

### Added

- Added PAYDAY 2 support, including browsing, installing, enabling/disabling, and launching mods.
- Added PAYDAY: The Heist support, including DAHM and mod_overrides handling.
- Added a first-launch welcome screen for game selection.
- Added per-game settings, with migration from the previous single-game configuration.
- Added Discord and Documentation links in the UI.
- Added opt-in usage analytics with a first-run consent dialog and Settings toggle.
- Added one-click SuperBLT installation from dependency warnings.
- Added RAR archive support for mod installation.
- Added support for host-mod content packs.
- Added reinstall support for installed mods whose files are missing.
- Added Manage Files improvements, including search, batch enable/disable, cleaner filenames, and missing-file rows.

### Changed

- Renamed the app data identifier to `modrex` with migration support for existing installs.
- Replaced browser title hints with app tooltips throughout the UI.
- Improved dependency warnings for manual/offsite dependencies and SuperBLT.

### Fixed

- Fixed link-only mod dependencies opening as install errors instead of browser links.
- Fixed update badges appearing when an installed version could not be determined.
- Fixed modworkshop rate-limit issues during rapid browsing and refreshes.
- Fixed browse-page scroll reset behavior after filters, sorting, search, category, or page changes.
- Fixed swallowed install errors on the mod detail page.
- Fixed incorrect version formatting on the mod detail page.
- Fixed stale game state flashing during game switches.
- Fixed invalid game paths remaining after the game executable is removed.
- Fixed launcher selection being reset after game path validation.
- Fixed launch-without-mods behavior for BLT-based games.
- Fixed Manage Files filename display and toggle behavior.
- Fixed Settings dropdown scrolling.
- Fixed upgrade migration from the old `pd3-mod-manager` app identifier.

### Security

- Added a Content Security Policy for the app window.
- Added external URL scheme allowlisting before opening links.
- Hardened archive extraction against path traversal entries.

## 0.9.1

- Added a manual refresh button to the installed mods header
- Mod images are now cached on disk
- Added support for installing .7z and .tar.gz / .tar.xz archives
- Fixed the installed mods count showing the number of files instead of unique mods
- Performance improvements to the installed page and update detection

## 0.9.0

- **.zip mods now install directly**
- Mods with files spread across folders now appear as a single card
- Browse page is now instant when switching tabs — results are cached
- Installed page loads instantly on restart
- Sort order and sidebar state are remembered between sessions
- Launcher icons now shown in Settings
- Mods marked by their author as incompatible with mod managers can no longer be installed

## 0.8.0

- **The app has been renamed from PD3 Mod Manager to Modrex**
- Migrated from Electron to Tauri v2
- Fixed mod cards showing as permanent loading skeletons for manually placed or unrecognized pak files
- Fixed mods with multiple .pak files not accumulating correctly on install - each file now tracks independently
- Fixed installed pak files getting removed when updating a multi-file mod
- Fixed update detection incorrectly flagging mods with multiple installed versions
- Fixed folder assignment being lost when updating a mod
- Fixed missing mods appearing in the available updates list
- Fixed game path detection not accepting paths identified by launcher marker files
- Fixed launch options not showing for Steam and Epic launchers
- Added "N files" badge on Browse page mod cards when the mod is already installed with multiple files
- Added error state on mod cards when an update fails
- Removed the Reset button from the game path settings section

## 0.7.2

- Fixed Xbox Game Pass: game now launches correctly instead of opening the Xbox app
- Fixed Xbox Game Pass: game is now detected in non-default install locations
- Fixed modworkshop API errors (429) when browsing mods or opening the app with many mods installed
- Xbox: launch options field is now disabled with a note explaining how to set `-fileopenlog` in the Xbox app instead

## 0.7.1

- Fixed Xbox / Game Pass support (game now launches correctly, custom install locations are detected)
- Fixed update banner reappearing after updating mods
- Fixed Browse Mods failing to load when many mods are installed

## 0.7.0

- **Added support for Epic Games Store and Xbox Game Pass versions of PAYDAY 3**
    - The Settings page now shows a launcher selector when PAYDAY 3 is detected on multiple platforms
    - Fixed a bug where updating a mod that received a new file ID would leave the old .pak on disk and reset the mod's load order position
    - Fixed the app making failed API requests for unrecognized mods, which could cause slowdowns on the Installed tab
    - Fixed rate limiting errors when loading metadata for large mod libraries
    - Lightened the app background color

## 0.6.0

- Mod description, changelog, and downloads pages now support YouTube and Streamable video embeds — click the thumbnail to play inline
- Collapsible sections in mod descriptions now render correctly and can be expanded
- Tables and other rich formatting in mod descriptions now display properly
- Changelog is now a separate tab; Dependencies & Instructions tab is hidden when there is nothing to show
- Code blocks in mod descriptions now have syntax highlighting matching modworkshop's style
- Colored text in mod descriptions (modworkshop color tags) now renders correctly
- Downloads tab redesigned to match modworkshop's layout with per-file thumbnails
- File format and size are now shown in the install button; the file label badge moved to the file name area
- Install Files dialog redesigned to match the downloads tab style

## 0.5.1

- Added skeleton loading screens on Browse and Installed pages
- Added enable/disable toggle directly on folder headers to bulk-toggle all mods inside a folder
- Replaced the browser's default delete confirmation popup with a proper in-app dialog
- Fixed mod reorder drag-and-drop not registering on the first hover in list mode
- Fixed inconsistent gaps between mod cards and folders in grid view
- Fixed folder header buttons and toggles being misaligned
- Fixed the game running indicator getting stuck when the game exits before the first poll
- Softened the file open log warning — it's a recommendation, not a requirement

## 0.5.0

- Added subfolder support — folders can now contain other folders at any depth
- Mods with multiple installed files are now grouped as a single card with a file count badge in list view
- File labels (Main, Optional) now appear as colored badges in the install dialog
- Fixed renaming a folder in the app not renaming the actual directory on disk
- Folder names now preserve spaces and uppercase letters on disk
- Fixed mod drag indicator not appearing over button areas in list view
- Fixed folders appearing interleaved with mods after drag-and-drop reordering
- Fixed new mod installs sometimes getting a priority that conflicts with a sibling folder

## 0.4.0

- The app now shows a loading screen on startup instead of a white flash while the window initialises.
- When auto-detection can't find your PAYDAY 3 installation, the Browse page now shows a Configure in Settings link so you can set the path in one click.
- Manually selecting a game folder now validates that it is a real PAYDAY 3 installation and shows an inline error if it isn't.
- Mod identification is more reliable: the app falls back to a name-based lookup when a .pak file's SHA256 hash isn't in the index, and correctly uses the mod's version when the index entry has an empty version field.
- Fixed an edge case where manually-placed mods could be assigned no version instead of the correct one from modworkshop.
- Added an Open log file button in Settings to make it easier to attach logs to bug reports.

## 0.3.0

- Untracked .pak files dropped manually into the mods folder are now matched against a remote SHA256 index of all modworkshop PD3 mods — matched mods
  appear with their real name, cover image, and version
    - SHA256 is stored on install so mods renamed or moved on disk are re-identified automatically
    - Clicking a launch button now immediately shows a spinner and disables both buttons until the game process is detected
    - Fixed .pak files in the disabled folder not being ignored by the game — they are now renamed to .pak.disabled so UE5 skips them correctly
    - Fixed mod state being read from the wrong location during a vanilla (no-mods) session
    - Fixed game path not refreshing when the app window regains focus
    - Fixed "Launch modded" being enabled when no game path is set
    - Fixed the update modal not reopening after a manual installer is launched
    - Added a "Check for updates" button in Settings

## 0.2.3

- Update notifications now appear as a pop-up window with patch notes and an Update button
- Clicking "Later" closes the pop-up without doing anything
- While downloading an update, a thin progress bar appears at the bottom of the title bar instead of a banner
- When the update is ready to install, a "Restart & Install" button appears in the title bar

## 0.2.2

test data

## 0.2.1

- In-app update notifications — a banner appears when a new version is available
- Patch notes are shown directly in the app before you update
- Update banner can be dismissed if you don't want to update right now

## 0.2.0

- App version is now shown in the title bar
- Browse page shows stats (likes, downloads, views, last updated) for installed mods instead of just the version number
- Drag ghost image is now a mini card with the mod's thumbnail and name
- List auto-scrolls when dragging a mod near the top or bottom edge
- Fixed mod cards in the grid stretching to inconsistent heights
- Fixed User-Agent header sending a static version instead of the real one
- Added a 15-second timeout to modworkshop API requests
- Fixed window focus triggering multiple rapid refresh calls

## 0.1.1

Add updater

## 0.1.0

Initial release
