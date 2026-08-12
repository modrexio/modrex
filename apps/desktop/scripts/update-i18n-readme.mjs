import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { formatPercentage, inspectLocales, localeNativeName } from './check-i18n.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const README_PATH = resolve(SCRIPT_DIR, '../../..', 'README.md')
const CONTRIBUTORS_PATH = resolve(SCRIPT_DIR, '..', 'translation-contributors.generated.json')
const START_MARKER = '<!-- TRANSLATION_STATUS_START -->'
const END_MARKER = '<!-- TRANSLATION_STATUS_END -->'
const GITHUB_USERNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/

function escapeTableText(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('|', '\\|')
}

export function readTranslationContributors(path = CONTRIBUTORS_PATH) {
    let contributors
    try {
        contributors = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
        throw new Error(`Failed to read translation contributors at ${path}`, { cause: error })
    }

    if (typeof contributors !== 'object' || contributors === null || Array.isArray(contributors)) {
        throw new Error('Translation contributors must be a JSON object')
    }

    for (const [localeId, usernames] of Object.entries(contributors)) {
        if (!Array.isArray(usernames) || usernames.length === 0) {
            throw new Error(`Translation contributors for '${localeId}' must be a non-empty array`)
        }
        if (new Set(usernames).size !== usernames.length) {
            throw new Error(`Translation contributors for '${localeId}' contain duplicates`)
        }
        for (const username of usernames) {
            if (typeof username !== 'string' || !GITHUB_USERNAME.test(username)) {
                throw new Error(`Invalid GitHub username for translation locale '${localeId}'`)
            }
        }
    }

    return contributors
}

function contributorLinks(usernames) {
    if (!usernames) return '-'
    return [...usernames]
        .sort()
        .map((username) => `[${username}](https://github.com/${username})`)
        .join(', ')
}

export function buildTranslationTable(inspection, contributors) {
    const localeIds = new Set([
        inspection.sourceLocale,
        ...inspection.locales.map((locale) => locale.id),
    ])
    for (const localeId of Object.keys(contributors)) {
        if (!localeIds.has(localeId)) {
            throw new Error(`Translation contributors reference unknown locale '${localeId}'`)
        }
    }

    const sourceName = escapeTableText(localeNativeName(inspection.sourceLocale))
    const sourceCoverage = formatPercentage(inspection.totalCount, inspection.totalCount)
    const lines = [
        '| Language | Coverage | Contributors |',
        '| --- | ---: | --- |',
        `| ${sourceName} (${inspection.sourceLocale}) | ${sourceCoverage} | ${contributorLinks(contributors[inspection.sourceLocale])} |`,
    ]

    for (const locale of inspection.locales) {
        const name = escapeTableText(localeNativeName(locale.id))
        const coverage = formatPercentage(locale.translatedCount, locale.totalCount)
        lines.push(
            `| ${name} (${locale.id}) | ${coverage} | ${contributorLinks(contributors[locale.id])} |`
        )
    }

    return lines.join('\n')
}

export function replaceTranslationTable(readme, table) {
    const start = readme.indexOf(START_MARKER)
    const end = readme.indexOf(END_MARKER)
    if (start === -1 || end === -1 || end < start) {
        throw new Error(`README.md must contain ${START_MARKER} before ${END_MARKER}`)
    }

    const before = readme.slice(0, start + START_MARKER.length)
    const after = readme.slice(end)
    return `${before}\n\n<!-- prettier-ignore -->\n${table}\n\n${after}`
}

export function expectedReadme(readme) {
    const inspection = inspectLocales()
    if (inspection.errors.length > 0) {
        throw new Error(
            `Cannot update README with invalid locales:\n${inspection.errors.join('\n')}`
        )
    }
    const contributors = readTranslationContributors()
    return replaceTranslationTable(readme, buildTranslationTable(inspection, contributors))
}

export function runReadmeCommand(
    args,
    { readmePath = README_PATH, stdout = process.stdout, stderr = process.stderr } = {}
) {
    const supported =
        args.length === 0 || (args.length === 1 && ['--stdout', '--check'].includes(args[0]))
    if (!supported) {
        stderr.write('Usage: update-i18n-readme.mjs [--stdout|--check]\n')
        return 2
    }

    const current = readFileSync(readmePath, 'utf8')
    const expected = expectedReadme(current)

    if (args[0] === '--stdout') {
        stdout.write(expected)
        return 0
    }

    if (args[0] === '--check') {
        if (expected === current) {
            stdout.write('update-i18n-readme: README.md is current\n')
            return 0
        }
        stderr.write('update-i18n-readme: README.md is out of date\n')
        return 1
    }

    if (expected === current) {
        stdout.write('update-i18n-readme: README.md is current\n')
        return 0
    }

    writeFileSync(readmePath, expected)
    stdout.write('update-i18n-readme: updated README.md\n')
    return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = runReadmeCommand(process.argv.slice(2))
}
