import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inspectLocales, localeNativeName } from './i18n-inspection.mjs'
import { buildStatusSummaries, deriveTargetStatus } from './i18n-presentation.mjs'
import {
    buildTranslationTable,
    readTranslationContributors,
    renderTranslationStatusReadme,
    replaceTranslationTable,
    runReadmeCommand,
} from './update-i18n-readme.mjs'

const names = { en: 'English', de: 'Deutsch', ru: 'Русский', uk: 'Українська' }
const contributors = {
    de: ['ZedTranslator', 'AlphaTranslator'],
    ru: ['RussianTranslator'],
    uk: ['UkrainianTranslator'],
}

function target(locale, accepted, pendingCompatible, pendingPlaceholderIncompatible, missing) {
    return {
        kind: 'target',
        locale,
        total: accepted + pendingCompatible + pendingPlaceholderIncompatible + missing,
        accepted,
        pendingCompatible,
        pendingPlaceholderIncompatible,
        missing,
    }
}

function render(targets = [target('uk', 4, 0, 0, 0)]) {
    return renderTranslationStatusReadme({
        summaries: {
            source: { kind: 'source', locale: 'en', total: 4 },
            targets,
        },
        names,
        contributors,
    })
}

test('README renderer emits three columns, canonical order, links, and bar-first cells', () => {
    const output = render([
        target('uk', 4, 0, 0, 0),
        target('de', 1, 2, 0, 1),
        target('ru', 4, 0, 0, 0),
    ])
    const rows = output.split('\n').filter((line) => line.startsWith('| '))
    assert.equal(rows[0], '| Language | Translation | Contributors |')
    assert.equal(rows[1], '| --- | --- | --- |')
    assert.deepEqual(
        rows.slice(2).map((row) => row.match(/i18n\/(en|de|ru|uk)\.json/u)?.[1]),
        ['en', 'de', 'ru', 'uk']
    )
    for (const row of rows.slice(2)) {
        assert.equal((row.match(/\|/gu) ?? []).length, 4)
        assert.doesNotMatch(row, /\]\(<img/u)
        const translation = row.split('|')[2]
        assert.match(translation.trim(), /^<img /u)
    }
    assert.match(output, /\[Deutsch \(de\)\]\(apps\/desktop\/src\/renderer\/src\/i18n\/de\.json\)/u)
    assert.doesNotMatch(output, /\\apps\\|github\.com\/.*\/edit/u)
})

test('English and target labels preserve Complete versus translated 100 percent semantics', () => {
    const output = render([target('de', 2, 1, 0, 1), target('ru', 3, 1, 0, 0)])
    assert.match(output, /en\.svg[^\n]*> Complete/u)
    assert.match(output, /de\.svg[^\n]*> 75%/u)
    assert.match(output, /ru\.svg[^\n]*> 100%/u)
    assert.doesNotMatch(output, /ru\.svg[^\n]*Complete/u)
    assert.doesNotMatch(output, /en\.svg[^\n]*%/u)
})

test('fallback wording, alt text, and zero-fallback omission share one summary', () => {
    const singular = render([target('de', 2, 1, 1, 0)])
    assert.match(singular, /1 uses English fallback/u)
    assert.equal((singular.match(/1 uses English fallback/gu) ?? []).length, 2)

    const plural = render([target('de', 2, 0, 2, 0)])
    assert.match(plural, /2 use English fallback/u)
    assert.equal((plural.match(/2 use English fallback/gu) ?? []).length, 2)

    const zero = render([target('de', 3, 1, 0, 0)])
    const zeroRow = zero.split('\n').find((line) => line.includes('de.svg'))
    assert.ok(zeroRow)
    assert.doesNotMatch(zeroRow, /English fallback|<sub>/u)
})

test('legend is rendered in memory with future Step 7 paths and compact labels', () => {
    const output = render()
    for (const state of ['accepted', 'review', 'missing']) {
        assert.match(output, new RegExp(`assets/i18n/status/legend/${state}\\.svg`, 'u'))
    }
    assert.match(output, /Accepted <img[^>]+review\.svg[^>]+> Review /u)
    assert.match(output, /missing\.svg[^>]+> Missing(?:<|\s|$)/u)
    assert.doesNotMatch(
        output,
        /Review needed|100% means every key|Complete means no known|Pending translations with incompatible|For English, Complete|[·—]/u
    )
    assert.match(output, /translation guide/u)
})

test('README output is deterministic, escaped, and preserves the translation-guide destination', () => {
    const escaped = renderTranslationStatusReadme({
        summaries: { source: { kind: 'source', locale: 'en', total: 1 }, targets: [] },
        names: { en: 'English & <source> "bundle"' },
        contributors: {},
    })
    assert.equal(
        escaped,
        renderTranslationStatusReadme({
            summaries: { source: { kind: 'source', locale: 'en', total: 1 }, targets: [] },
            names: { en: 'English & <source> "bundle"' },
            contributors: {},
        })
    )
    assert.match(escaped, /English &amp; &lt;source&gt; "bundle"/u)
    assert.match(escaped, /assets\/i18n\/status\/legend\/missing\.svg/u)
})

test('Step 6 command rendering does not write README.md', () => {
    const directory = mkdtempSync(join(tmpdir(), 'modrex-readme-step6-'))
    const readmePath = join(directory, 'README.md')
    const original = '<!-- TRANSLATION_STATUS_START -->\nstale\n<!-- TRANSLATION_STATUS_END -->\n'
    writeFileSync(readmePath, original)
    try {
        const stdout = {
            value: '',
            write(chunk) {
                this.value += chunk
            },
        }
        assert.equal(runReadmeCommand([], { readmePath, stdout }), 0)
        assert.equal(readFileSync(readmePath, 'utf8'), original)
        assert.match(stdout.value, /README\.md unchanged/u)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('simulated Step 7 replacement is idempotent and preserves exactly one guide and marker pair', () => {
    const fixture = [
        'before sentinel',
        '<!-- TRANSLATION_STATUS_START -->',
        'old generated content',
        '<!-- TRANSLATION_STATUS_END -->',
        '',
        'To improve an existing language or add a new one, follow the',
        '[translation guide](TRANSLATING.md).',
        'after sentinel',
    ].join('\n')
    const first = replaceTranslationTable(fixture, render())
    const second = replaceTranslationTable(first, render())
    assert.equal(second, first)
    assert.equal((first.match(/\[translation guide\]\(TRANSLATING\.md\)/gu) ?? []).length, 1)
    assert.equal((first.match(/<!-- TRANSLATION_STATUS_START -->/gu) ?? []).length, 1)
    assert.equal((first.match(/<!-- TRANSLATION_STATUS_END -->/gu) ?? []).length, 1)
    assert.match(first, /before sentinel[\s\S]*after sentinel/u)
    const guide = first.indexOf('[translation guide](TRANSLATING.md)')
    const end = first.indexOf('<!-- TRANSLATION_STATUS_END -->')
    assert.ok(guide < end)
    assert.ok(end - guide < 200)
})

test('dynamic alt values are escaped through the production image serializer', () => {
    const output = renderTranslationStatusReadme({
        summaries: {
            source: { kind: 'source', locale: 'en', total: 2 },
            targets: [target('de', 1, 0, 1, 0)],
        },
        names: { en: 'English', de: 'A&B <Test> "Quoted"' },
        contributors: {},
    })
    const image = output.match(/<img src="assets\/i18n\/status\/de\.svg"[^>]+>/u)?.[0]
    assert.ok(image)
    assert.match(
        image,
        /alt="A&amp;B &lt;Test&gt; &quot;Quoted&quot; \(de\): 1 accepted, 1 review, 0 missing; 100%\. 1 uses English fallback\."/u
    )
    assert.doesNotMatch(image, /<Test>|alt="[^"]*"[^"]*"/u)
    assert.match(image, /1 uses English fallback/u)
})

test('pure renderer follows supplied summaries without filesystem status recalculation', () => {
    const output = renderTranslationStatusReadme({
        summaries: {
            source: { kind: 'source', locale: 'en', total: 7 },
            targets: [target('synthetic', 5, 1, 0, 1)],
        },
        names: { en: 'English', synthetic: 'Synthetic [Locale] (\u005c)' },
        contributors: { synthetic: ['FixtureUser'] },
    })
    assert.match(output, /English source: 7 valid strings/u)
    assert.match(output, /synthetic\.svg[^\n]*> 85\.7%/u)
    assert.ok(output.includes('Synthetic \\[Locale\\] \\(\\\\\\) (synthetic)'))
})

test('table pipes and Markdown-special locale names remain one safe table cell', () => {
    const output = renderTranslationStatusReadme({
        summaries: {
            source: { kind: 'source', locale: 'en', total: 1 },
            targets: [target('de', 1, 0, 0, 0)],
        },
        names: { en: 'English', de: 'A | B [x] (y) \\' },
        contributors: { de: ['FixtureUser'] },
    })
    const row = output.split('\n').find((line) => line.includes('de.svg'))
    assert.ok(row)
    const rowWithoutImage = row.replace(/<img [^>]+>/u, '')
    assert.equal((rowWithoutImage.match(/(?<!\\)\|/gu) ?? []).length, 4)
    assert.ok(row.includes('A \\| B \\[x\\] \\(y\\) \\\\ (de)'))
})

test('current summaries and contributors remain reflected in the expected block', () => {
    const inspection = inspectLocales()
    const summaries = buildStatusSummaries(inspection)
    const names = Object.fromEntries([
        [inspection.sourceLocale, localeNativeName(inspection.sourceLocale)],
        ...inspection.locales.map((locale) => [locale.id, localeNativeName(locale.id)]),
    ])
    const contributors = readTranslationContributors()
    const output = renderTranslationStatusReadme({ summaries, names, contributors })
    assert.match(output, /English \(en\)[^\n]*en\.svg[^\n]*> Complete/u)
    for (const summary of summaries.targets) {
        const row = output.split('\n').find((line) => line.includes(`${summary.locale}.svg`))
        assert.ok(row)
        assert.match(
            row,
            new RegExp(`> ${deriveTargetStatus(summary).label.replaceAll('%', '\\%')}`)
        )
        for (const username of contributors[summary.locale] ?? []) {
            assert.match(row, new RegExp(`https://github\\.com/${username}`))
        }
    }
})
