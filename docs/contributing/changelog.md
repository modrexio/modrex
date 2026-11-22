# Writing a changelog entry

Every change people using Modrex would notice gets one file in [`.changes/`](../../.changes/).
Do not edit `CHANGELOG.md`: `bun release` builds the next version's section from these files and
deletes them, and each nightly build reads them for its notes. CI fails when `CHANGELOG.md` has
an Unreleased section.

## The file

Name it after the change, for example `.changes/mod-profiles.md`:

```md
---
category: added
---

Added mod profiles for each game.
```

- `category` is one of `added`, `changed`, `deprecated`, `removed`, `fixed` or `security`.
- The text is one sentence or a short paragraph in past tense, written for players rather than
  developers: "Fixed X when Y.", not a commit subject. Leave out the list marker, PR numbers and
  your name. They are added for you.

Two optional header lines:

- `prs: [229, 231]` names the pull requests the change came from. Without it, the entry links
  the pull request that created the file. Either way, every later pull request that edits the
  file is linked too.
- `thanks: [@login, someone (Discord)]` credits people who did not open a pull request, such as
  whoever reported the bug. `@login` becomes a link to that GitHub account, anything else stays
  plain text.

A pull request with several user-facing changes writes several files. A fix to a change that has
not been released yet edits that change's file instead of adding a new one.

`bun check-changes` checks the files the way CI does.

## How credit works

Each entry names the authors and co-authors of its pull requests. Maintainers, listed in
`MAINTAINERS` in `apps/desktop/scripts/changes.mts`, are left out of entries because they take
part in nearly every change. The notes end with a thank-you to everyone whose pull request or
commit landed since the last release, maintainers included.

Bots are never credited. A `Co-authored-by` email that belongs to no GitHub account is credited
by name only once a maintainer lists it under `people` in `.changes/co-authors.json`. One listed
under `bots`, such as an AI tool, is never credited. `bun release` stops on an email that is in
neither list, and a nightly build leaves it out with a warning.
