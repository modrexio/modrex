---
name: pr
description: Prepare a pull request's title, body and labels, and open it after approval
---

# pr

Prepare a pull request from the current branch into `main`. Open it only after the user
approves the exact title, body and labels.

## Title

PRs are squash-merged, so the title becomes the commit on `main`. Follow
[`commitlint.config.ts`](../../../commitlint.config.ts) and keep it short enough that the
appended ` (#N)` stays within 72 characters.

## Body

Fill [`.github/pull_request_template.md`](../../../.github/pull_request_template.md).
Remove its HTML comments, drop the Translation section when it does not apply, and tick
only the validation that actually ran.

## Labels

Pick exactly one primary label by the PR's purpose, not by the files it touches. For user
facing changes, ask whether users could do this before: no means `feature`, yes but broken
means `bug`, yes and now better means `improvement`.

- `bug`: fixes broken behavior in the app, site or index
- `feature`: adds something users could not do before
- `improvement`: makes existing behavior faster, clearer or easier to use
- `translation`: locale updates or a new language
- `maintenance`: CI, build, tooling, refactors, release plumbing
- `dependencies`: dependency bumps and advisory patches
- `documentation`: docs are the whole change

Docs or tooling changed alongside a fix or feature belong to that fix or feature. Tick the
template's Type of change box that matches the primary label.

Add either extra label when it applies:

- `game support`: behavior specific to one game or loader
- `security`: fixes an advisory, a leak or an exploitable hole

## Rules

- The branch must already be on the remote. Never push it. If it is missing, give the
  user the push command and stop.
- Show the title, body and labels, then wait for explicit approval.
- After approval, run `gh pr create --base main --title ... --body-file ... --label ...`
  with one `--label` per label.
