# Security Policy

## Supported versions

Only the latest release is supported. Modrex updates itself through its built-in updater, so a fix reaches all users as soon as a new release is published; older versions do not receive separate patches.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's advisory form:

**<https://github.com/modrexio/modrex/security/advisories/new>**

If you can't use GitHub, email **security@modrex.net** instead.

Please do not open a public issue and do not post details in Discord. Both are public, and an exploitable bug in a mod manager can put every user's machine at risk before a fix exists.

A useful report includes:

- your Modrex version (shown in the top bar) and operating system
- steps to reproduce, or a proof of concept - a crafted archive or mod description is ideal
- what an attacker gains from the bug

Modrex is maintained by one person. Expect an acknowledgment within seven days, usually much sooner. If the report is valid, you will be kept informed of the fix and release timeline, and credited in the release notes unless you prefer otherwise.

## Scope

Modrex downloads and installs third-party content, renders third-party text, and updates itself. Reports in these areas are especially valuable:

- archive extraction writing outside the intended mod directory (path traversal, crafted entry names, symlinks)
- install, uninstall, enable, or disable operations deleting or modifying files that do not belong to the managed mod
- mod descriptions (markdown and HTML from modworkshop) executing script or bypassing the sanitizer or the app's Content Security Policy
- links or embeds launching arbitrary programs or bypassing the URL scheme allowlist
- the update pipeline accepting a tampered or wrongly signed artifact
- the Linux install script delivered at modrex.net/install.sh
- Nexus Mods OAuth tokens landing outside the OS credential store on a platform where one is available, or being exposed in logs

Vulnerabilities in the companion repositories ([modrex-index](https://github.com/modrexio/modrex-index), [modrex-site](https://github.com/modrexio/modrex-site), [mget](https://github.com/modrexio/mget)) affect the same users - report them the same way.

Out of scope:

- vulnerabilities in the games themselves, or in mods as game content; a mod that attacks Modrex itself (for example through a crafted archive) is in scope
- issues on modworkshop.net - report those to ModWorkshop
- attacks that require an already-compromised machine or existing administrator access

## Disclosure

Please give a fix a chance to ship before publishing details. Because of the built-in updater, most users are protected within days of a release; exact timing can be agreed in the advisory thread.
