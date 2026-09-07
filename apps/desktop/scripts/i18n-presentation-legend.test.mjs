import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { inspectLocales, SOURCE_LOCALE } from './i18n-inspection.mjs'
import {
    expectedReadme,
    materializeReadme,
    readTranslationContributors,
} from './update-i18n-readme.mjs'

const ROOT = resolve(import.meta.dirname, '../../..')
const README_PATH = resolve(ROOT, 'README.md')
const LEGEND_DIR = resolve(ROOT, 'assets/i18n/status/legend')
const LEGEND_COLORS = {
    accepted: '#2DA44E',
    review: '#D4A72C',
    missing: '#C94A4A',
}

function readLegend(name) {
    return readFileSync(resolve(LEGEND_DIR, `${name}.svg`), 'utf8')
}

test('legend assets are canonical solid, secure, and newline-stable SVGs', () => {
    assert.deepEqual(readdirSync(LEGEND_DIR).sort(), ['accepted.svg', 'missing.svg', 'review.svg'])
    for (const [name, color] of Object.entries(LEGEND_COLORS)) {
        const svg = readLegend(name)
        assert.match(svg, new RegExp(`fill="${color}"`, 'u'))
        assert.match(svg, /^<svg [^>]+><rect [^>]+\/><\/svg>\n$/u)
        assert.doesNotMatch(
            svg,
            /#E36300|pattern|gradient|<text|script|foreignObject|href=|src=|on\w+=|animation/u
        )
        assert.doesNotMatch(svg, /\r/u)
    }
})

// These assert the shape of the block the generator produces from current locale state.
// Whether README.md has caught up with that is the bot's business, checked by
// pnpm i18n:presentation-check rather than by a unit test over the committed file.
test('the generated README block owns its markers and resolves every legend image', () => {
    const readme = expectedReadme(readFileSync(README_PATH, 'utf8'))
    assert.equal((readme.match(/\[translation guide\]\(TRANSLATING\.md\)/gu) ?? []).length, 1)
    assert.equal((readme.match(/<!-- TRANSLATION_STATUS_START -->/gu) ?? []).length, 1)
    assert.equal((readme.match(/<!-- TRANSLATION_STATUS_END -->/gu) ?? []).length, 1)
    const generated = readme.slice(
        readme.indexOf('<!-- TRANSLATION_STATUS_START -->'),
        readme.indexOf('<!-- TRANSLATION_STATUS_END -->')
    )
    const imagePaths = [...generated.matchAll(/src="(assets\/i18n\/status\/[^"?]+\.svg)"/gu)].map(
        ([, path]) => path
    )
    const targetIds = inspectLocales().locales.map((locale) => locale.id)
    assert.deepEqual(
        [...new Set(imagePaths)].sort(),
        [
            `assets/i18n/status/${SOURCE_LOCALE}.svg`,
            ...targetIds.map((id) => `assets/i18n/status/${id}.svg`),
            'assets/i18n/status/legend/accepted.svg',
            'assets/i18n/status/legend/missing.svg',
            'assets/i18n/status/legend/review.svg',
        ].sort()
    )
    // Legend images are hand-maintained and must exist. Per-locale status images are bot
    // output and may not exist yet for a locale added in the commit being tested.
    for (const path of imagePaths.filter((item) => item.includes('/legend/'))) {
        assert.ok(readFileSync(resolve(ROOT, path)))
    }
    assert.match(generated, /\| Language \| Translation \| Contributors \|/u)
    assert.match(generated, new RegExp(`${SOURCE_LOCALE}\\.svg[^\\n]*> Complete`, 'u'))

    // A target locale reads Complete once nothing is pending or missing and shows a percentage
    // until then, so asserting either form outright breaks when a locale finishes.
    for (const locale of inspectLocales().locales) {
        const finished = locale.pendingCount === 0 && locale.missingCount === 0
        const shown = finished ? 'Complete' : '\\d{1,3}(?:\\.\\d)?%'
        assert.match(generated, new RegExp(`${locale.id}\\.svg[^\\n]*> ${shown}`, 'u'))
        if (finished) continue
        assert.doesNotMatch(generated, new RegExp(`${locale.id}\\.svg[^\\n]*Complete`, 'u'))
    }
    assert.match(generated, /<img src="assets\/i18n\/status\/en\.svg"/u)
    assert.doesNotMatch(generated, /\[<img|<a [^>]*><img/u)
    assert.match(generated, /accepted\.svg[^>]+> Accepted /u)
    assert.match(generated, /review\.svg[^>]+> Review /u)
    assert.match(generated, /missing\.svg[^>]+> Missing(?:<|\s|$)/u)
    assert.doesNotMatch(generated, /English fallback/u)
    assert.doesNotMatch(
        generated,
        /Review needed|100% means every key|Complete means no known|Pending translations with incompatible|For English, Complete|[·—]/u
    )
    assert.match(
        generated,
        /\[English \(en\)\]\(apps\/desktop\/src\/renderer\/src\/i18n\/en\.json\)/u
    )
    assert.match(generated, /\[translation guide\]\(TRANSLATING\.md\)/u)
    assert.doesNotMatch(generated, /0 use English fallback|<sub>/u)
})

test('README materialization is idempotent and current contributors remain linked', () => {
    const before = readFileSync(README_PATH, 'utf8')
    // Materialize a copy: this suite must never write a tracked file, and the committed
    // README is allowed to lag until the bot runs.
    const directory = mkdtempSync(join(tmpdir(), 'modrex-readme-'))
    const path = join(directory, 'README.md')
    writeFileSync(path, before)
    const first = materializeReadme(path)
    const second = materializeReadme(path)
    assert.equal(first, expectedReadme(before))
    assert.equal(second, first)
    assert.equal(readFileSync(path, 'utf8'), first)
    assert.equal(readFileSync(README_PATH, 'utf8'), before)
    rmSync(directory, { recursive: true, force: true })
    const contributors = readTranslationContributors()
    for (const [locale, usernames] of Object.entries(contributors)) {
        for (const username of usernames) {
            assert.match(
                first,
                new RegExp(`\\[${username}\\]\\(https://github\\.com/${username}\\)`)
            )
        }
        assert.match(first, new RegExp(`status/${locale}\\.svg`))
    }
})
