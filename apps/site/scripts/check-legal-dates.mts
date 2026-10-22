// Fails when a legal page's "Last updated" date is older than the change it describes.
//
// The date is deliberately NOT derived from git at build time. Two reasons: git log on a
// file bumps for a Prettier reformat or a CSS tweak just as readily as for a wording change,
// which would move a legal date for a non-legal reason; and the deploy host is not
// guaranteed to clone with enough history to answer the question at all. So the page states
// its own date, an author decides when a change is substantive, and this script is what stops
// that date from quietly rotting.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const siteDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(siteDir, '../..')

const PAGES = ['src/pages/privacy.astro', 'src/pages/terms.astro']
const DATE_PATTERN = /^const LAST_UPDATED = '(\d{4}-\d{2}-\d{2})'$/m

function git(...args: string[]) {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}

function today() {
    return new Date().toISOString().slice(0, 10)
}

/** True when the file differs from HEAD, staged or not: the change is happening right now. */
function hasPendingChanges(repoPath: string) {
    return git('status', '--porcelain', '--', repoPath) !== ''
}

/** Commit date (YYYY-MM-DD) of the newest commit touching the file, or null if unknown. */
function lastCommitDate(repoPath: string) {
    return git('log', '-1', '--format=%cs', '--', repoPath) || null
}

const failures: string[] = []
const lines: string[] = []

// A shallow clone (actions/checkout defaults to depth 1) can answer "is this file dirty" but
// not "when was it last committed". Detect it once so a missing history reads as a setup
// problem rather than silently passing every page.
const isShallow = git('rev-parse', '--is-shallow-repository') === 'true'

for (const page of PAGES) {
    const repoPath = relative(repoRoot, resolve(siteDir, page)).split('\\').join('/')
    const source = readFileSync(resolve(siteDir, page), 'utf8')

    const match = source.match(DATE_PATTERN)
    if (!match) {
        failures.push(`${page}: no \`const LAST_UPDATED = 'YYYY-MM-DD'\` declaration found.`)
        continue
    }
    const stated = match[1]

    if (hasPendingChanges(repoPath)) {
        // Being edited in this commit, so the date has to be today's or the published page
        // ships describing wording it predates.
        if (stated !== today()) {
            failures.push(
                `${page} has uncommitted changes but says "${stated}".\n` +
                    `  Set LAST_UPDATED to '${today()}' if the wording changed in substance,\n` +
                    `  or revert the page if the edit was cosmetic.`
            )
            continue
        }
        lines.push(`check-legal-dates: ${page}  ${stated}  OK (updated in this change)`)
        continue
    }

    if (isShallow) {
        lines.push(`check-legal-dates: ${page}  ${stated}  SKIPPED (shallow clone, no history)`)
        continue
    }

    const committed = lastCommitDate(repoPath)
    if (!committed) {
        failures.push(`${page}: no commit touches this file, so its date cannot be verified.`)
        continue
    }
    if (committed > stated) {
        failures.push(
            `${page} was last changed on ${committed} but still says "${stated}".\n` +
                `  Bump LAST_UPDATED to '${committed}' or later.`
        )
        continue
    }
    lines.push(`check-legal-dates: ${page}  ${stated}  OK`)
}

if (failures.length > 0) {
    console.error(failures.join('\n\n'))
    process.exit(1)
}

console.log(lines.join('\n'))
if (isShallow) {
    console.log(
        'check-legal-dates: repository is a shallow clone; add `fetch-depth: 0` to the\n' +
            '  checkout step for this check to verify committed pages.'
    )
}
