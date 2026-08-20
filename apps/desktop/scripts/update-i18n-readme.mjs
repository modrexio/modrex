import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inspectLocales, localeNativeName } from './i18n-inspection.mjs'
import {
    buildStatusSummaries,
    deriveTargetStatus,
    targetFallbackLabel,
} from './i18n-presentation.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const README_PATH = resolve(SCRIPT_DIR, '../../..', 'README.md')
const CONTRIBUTORS_PATH = resolve(SCRIPT_DIR, '..', 'translation-contributors.generated.json')
const START_MARKER = '<!-- TRANSLATION_STATUS_START -->'
const END_MARKER = '<!-- TRANSLATION_STATUS_END -->'
const TRANSLATION_GUIDE =
    'To improve an existing language or add a new one, follow the\n[translation guide](TRANSLATING.md).'
const GITHUB_USERNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/

function escapeMarkdownLinkText(value) {
    return String(value)
        .replaceAll('\\', '\\\\')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('|', '\\|')
        .replaceAll('[', '\\[')
        .replaceAll(']', '\\]')
        .replaceAll('(', '\\(')
        .replaceAll(')', '\\)')
}

function escapeHtmlAttribute(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
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

function buildLocaleRows(inspection, contributors) {
    const localeIds = new Set([
        inspection.sourceLocale,
        ...inspection.locales.map((locale) => locale.id),
    ])
    for (const localeId of Object.keys(contributors)) {
        if (!localeIds.has(localeId)) {
            throw new Error(`Translation contributors reference unknown locale '${localeId}'`)
        }
    }

    return {
        sourceLocale: inspection.sourceLocale,
        names: Object.fromEntries([
            [inspection.sourceLocale, localeNativeName(inspection.sourceLocale)],
            ...inspection.locales.map((locale) => [locale.id, localeNativeName(locale.id)]),
        ]),
        contributors,
    }
}

function renderImage(locale, alt) {
    return `<img src="assets/i18n/status/${locale}.svg" alt="${escapeHtmlAttribute(alt)}">`
}

function renderSourceRow(summary, metadata) {
    const rawName = metadata.names[summary.locale]
    const name = escapeMarkdownLinkText(rawName)
    const alt = `English source: ${summary.total} valid strings.`
    return `| [${name} (${summary.locale})](apps/desktop/src/renderer/src/i18n/${summary.locale}.json) | ${renderImage(summary.locale, alt)} Complete | ${contributorLinks(metadata.contributors[summary.locale])} |`
}

function renderTargetRow(summary, metadata) {
    const status = deriveTargetStatus(summary)
    const rawName = metadata.names[summary.locale]
    const name = escapeMarkdownLinkText(rawName)
    const fallback = status.usesEnglishFallback
        ? ` ${targetFallbackLabel(status.usesEnglishFallback)}.`
        : ''
    const alt = `${rawName} (${summary.locale}): ${summary.accepted} accepted, ${status.pending} review, ${summary.missing} missing; ${status.label}.${fallback}`
    const fallbackLine = status.usesEnglishFallback
        ? `<br><sub>${targetFallbackLabel(status.usesEnglishFallback)}</sub>`
        : ''
    return `| [${name} (${summary.locale})](apps/desktop/src/renderer/src/i18n/${summary.locale}.json) | ${renderImage(summary.locale, alt)} ${status.label}${fallbackLine} | ${contributorLinks(metadata.contributors[summary.locale])} |`
}

function renderLegend() {
    return '<div class="i18n-status-legend"><img src="assets/i18n/status/legend/accepted.svg" alt=""> Accepted <img src="assets/i18n/status/legend/review.svg" alt=""> Review <img src="assets/i18n/status/legend/missing.svg" alt=""> Missing</div>'
}

export function renderTranslationStatusReadme({ summaries, names, contributors }) {
    if (!summaries?.source || !Array.isArray(summaries.targets)) {
        throw new Error('README renderer requires source and target summaries')
    }
    const metadata = { names, contributors }
    const rows = [
        '| Language | Translation | Contributors |',
        '| --- | --- | --- |',
        renderSourceRow(summaries.source, metadata),
        ...summaries.targets
            .slice()
            .sort((a, b) => a.locale.localeCompare(b.locale))
            .map((summary) => renderTargetRow(summary, metadata)),
    ]
    return `${rows.join('\n')}\n\n${renderLegend()}\n\n${TRANSLATION_GUIDE}`
}

export function buildTranslationTable(
    inspection,
    contributors,
    summaries = buildStatusSummaries(inspection)
) {
    const metadata = buildLocaleRows(inspection, contributors)
    return renderTranslationStatusReadme({ summaries, ...metadata })
}

export function replaceTranslationTable(readme, table) {
    const start = readme.indexOf(START_MARKER)
    const end = readme.indexOf(END_MARKER)
    if (start === -1 || end === -1 || end < start) {
        throw new Error(`README.md must contain ${START_MARKER} before ${END_MARKER}`)
    }

    const before = readme.slice(0, start + START_MARKER.length)
    const after = readme.slice(end).replace(`\n\n${TRANSLATION_GUIDE}`, '')
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

export function materializeReadme(readmePath = README_PATH) {
    const current = readFileSync(readmePath, 'utf8')
    const expected = expectedReadme(current)
    if (expected !== current) writeFileSync(readmePath, expected)
    return expected
}

export function runReadmeCommand(
    args,
    { readmePath = README_PATH, stdout = process.stdout, stderr = process.stderr } = {}
) {
    const supported =
        args.length === 0 ||
        (args.length === 1 && ['--stdout', '--check', '--write'].includes(args[0]))
    if (!supported) {
        stderr.write('Usage: update-i18n-readme.mjs [--stdout|--check|--write]\n')
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

    if (args[0] === '--write') {
        const expected = materializeReadme(readmePath)
        stdout.write(
            expected === current
                ? 'update-i18n-readme: README.md is current\n'
                : 'update-i18n-readme: updated README.md\n'
        )
        return 0
    }

    if (expected === current) {
        stdout.write('update-i18n-readme: README.md is current\n')
        return 0
    }

    stdout.write('update-i18n-readme: rendered expected README in memory; README.md unchanged\n')
    return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = runReadmeCommand(process.argv.slice(2))
}
