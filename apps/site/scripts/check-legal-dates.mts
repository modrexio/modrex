import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { legalContent } from './legal-content.mts'

const PAGES = ['apps/site/src/pages/privacy.astro', 'apps/site/src/pages/terms.astro']
const DATE_PATTERN = /^const LAST_UPDATED = '(\d{4}-\d{2}-\d{2})'$/m

export function checkLegalDates(repoRoot: string, today: string) {
    const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
    const failures: string[] = []
    const lines: string[] = []

    if (git('rev-parse', '--is-shallow-repository') === 'true') {
        failures.push('Legal date checks require full Git history. Use fetch-depth: 0 in CI.')
        return { failures, lines }
    }

    for (const page of PAGES) {
        const log = git('log', '--format=%H%x09%cs', '--', page)
        if (!log) {
            failures.push(`${page}: no committed legal content is available to compare.`)
            continue
        }
        const history = log.split('\n').map((entry) => {
            const [commit, date] = entry.split('\t')
            if (!commit || !date) throw new Error(`Invalid Git history entry for ${page}`)
            return { commit, date }
        })
        const latest = history[0]!
        const committedContent = legalContent(git('show', `${latest.commit}:${page}`))
        let changedOn = latest.date

        // check-legal-dates.test.mts covers wording dates across later formatting commits.
        for (const { commit, date } of history) {
            if (legalContent(git('show', `${commit}:${page}`)) !== committedContent) break
            changedOn = date
        }

        const working = readFileSync(resolve(repoRoot, page), 'utf8')
        const index = git('show', `:${page}`)
        const versions: [string, string][] = [['working tree', working]]
        if (index !== working.trim()) versions.push(['index', index])

        for (const [location, source] of versions) {
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
            const contentChanged = legalContent(source) !== committedContent
            const required = contentChanged ? today : changedOn
            if (stated < required) {
                failures.push(
                    `${page} (${location}): legal content changed on ${required} but LAST_UPDATED is ${stated}.`
                )
            }
        }
        lines.push(`check-legal-dates: ${page} checked against legal content history`)
    }

    return { failures, lines }
}

if (import.meta.main) {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const { failures, lines } = checkLegalDates(repoRoot, new Date().toISOString().slice(0, 10))
    if (failures.length > 0) {
        console.error(failures.join('\n\n'))
        process.exit(1)
    }
    console.log(lines.join('\n'))
}
