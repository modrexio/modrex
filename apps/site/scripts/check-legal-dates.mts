import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { legalContent } from './legal-content.mts'

const PAGES = ['apps/site/src/pages/privacy.astro', 'apps/site/src/pages/terms.astro']
const DATE_PATTERN = /^const LAST_UPDATED = '(\d{4}-\d{2}-\d{2})'$/m

function nextDay(iso: string): string {
    const date = new Date(`${iso}T00:00:00Z`)
    date.setUTCDate(date.getUTCDate() + 1)
    return date.toISOString().slice(0, 10)
}

// The stated date moves exactly when the wording does. Each version of a page is compared
// with the one before it rather than with commit dates, which squash merges and time zones
// shift. base is the published page, compared with HEAD; HEAD is compared with the index and
// the working tree.
export function checkLegalDates(repoRoot: string, today: string, base: string) {
    const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
    const failures: string[] = []
    const lines: string[] = []

    for (const page of PAGES) {
        const published = git('show', `${base}:${page}`)
        const committed = git('show', `HEAD:${page}`)
        const working = readFileSync(resolve(repoRoot, page), 'utf8')
        const index = git('show', `:${page}`)

        const versions: { location: string; source: string; previous: string }[] = [
            { location: 'HEAD', source: committed, previous: published },
        ]
        if (working.trim() !== committed) {
            versions.push({ location: 'working tree', source: working, previous: committed })
        }
        if (index !== committed && index !== working.trim()) {
            versions.push({ location: 'index', source: index, previous: committed })
        }

        for (const { location, source, previous } of versions) {
            const stated = source.match(DATE_PATTERN)?.[1]
            if (!stated) {
                failures.push(`${page} (${location}): missing LAST_UPDATED in YYYY-MM-DD format.`)
                continue
            }
            const statedDate = new Date(`${stated}T00:00:00Z`)
            if (
                Number.isNaN(statedDate.getTime()) ||
                statedDate.toISOString().slice(0, 10) !== stated
            ) {
                failures.push(`${page} (${location}): invalid LAST_UPDATED date ${stated}.`)
                continue
            }
            const previousDate = previous.match(DATE_PATTERN)?.[1]
            if (!previousDate) {
                throw new Error(`${page}: the version before ${location} has no LAST_UPDATED`)
            }

            if (legalContent(source) === legalContent(previous)) {
                if (stated !== previousDate) {
                    failures.push(
                        `${page} (${location}): LAST_UPDATED moved to ${stated} without a wording change. Keep ${previousDate}.`
                    )
                }
                continue
            }
            // An uncommitted change is dated today. A committed one may be dated earlier than
            // the day it is merged, but never on or before the date it replaces.
            if (location !== 'HEAD') {
                if (stated !== today) {
                    failures.push(
                        `${page} (${location}): legal wording changed but LAST_UPDATED is ${stated}. Set it to ${today}.`
                    )
                }
                continue
            }
            if (stated <= previousDate || stated > nextDay(today)) {
                failures.push(
                    `${page} (${location}): legal wording changed since ${base} but LAST_UPDATED is ${stated}. It must be later than ${previousDate} and not in the future.`
                )
            }
        }
        lines.push(`check-legal-dates: ${page} checked against ${base}`)
    }

    return { failures, lines }
}

if (import.meta.main) {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const now = new Date()
    const today = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
    ].join('-')
    // CI names the page's previous version. Locally it is where the branch left main.
    const base =
        process.env.LEGAL_DATES_BASE ||
        execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], {
            cwd: repoRoot,
            encoding: 'utf8',
        }).trim()
    const { failures, lines } = checkLegalDates(repoRoot, today, base)
    if (failures.length > 0) {
        console.error(failures.join('\n\n'))
        process.exit(1)
    }
    console.log(lines.join('\n'))
}
