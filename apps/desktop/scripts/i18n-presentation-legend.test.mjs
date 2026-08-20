import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
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

test('materialized README owns the generated block and resolves every local status image', () => {
    const readme = readFileSync(README_PATH, 'utf8')
    assert.equal(readme, expectedReadme(readme))
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
    assert.deepEqual([...new Set(imagePaths)].sort(), [
        'assets/i18n/status/de.svg',
        'assets/i18n/status/en.svg',
        'assets/i18n/status/legend/accepted.svg',
        'assets/i18n/status/legend/missing.svg',
        'assets/i18n/status/legend/review.svg',
        'assets/i18n/status/ru.svg',
        'assets/i18n/status/uk.svg',
    ])
    for (const path of imagePaths) assert.ok(readFileSync(resolve(ROOT, path)))
    assert.match(generated, /\| Language \| Translation \| Contributors \|/u)
    assert.match(generated, /en\.svg[^\n]*> Complete/u)
    assert.match(generated, /de\.svg[^\n]*> 99\.5%/u)
    assert.doesNotMatch(generated, /de\.svg[^\n]*Complete/u)
    assert.match(generated, /ru\.svg[^\n]*> 99\.5%/u)
    assert.doesNotMatch(generated, /ru\.svg[^\n]*Complete/u)
    assert.match(generated, /uk\.svg[^\n]*> 99\.5%/u)
    assert.doesNotMatch(generated, /uk\.svg[^\n]*Complete/u)
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
    const first = materializeReadme(README_PATH)
    const second = materializeReadme(README_PATH)
    assert.equal(first, before)
    assert.equal(second, first)
    assert.equal(readFileSync(README_PATH, 'utf8'), before)
    const contributors = readTranslationContributors()
    for (const [locale, usernames] of Object.entries(contributors)) {
        for (const username of usernames) {
            assert.match(
                before,
                new RegExp(`\\[${username}\\]\\(https://github\\.com/${username}\\)`)
            )
        }
        assert.match(before, new RegExp(`status/${locale}\\.svg`))
    }
})
