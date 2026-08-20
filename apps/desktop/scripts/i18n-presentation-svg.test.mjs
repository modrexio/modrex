import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
    calculateSvgGeometry,
    generateStatusAssets,
    renderStatusSvg,
    STATUS_ASSET_DIR,
} from './i18n-presentation-svg.mjs'
import { buildStatusSummaries } from './i18n-presentation.mjs'
import { inspectLocales, validateLocaleId } from './i18n-inspection.mjs'

const REVIEW = '#D4A72C'

const target = (
    accepted,
    pendingCompatible,
    pendingPlaceholderIncompatible,
    missing,
    locale = 'de'
) => ({
    kind: 'target',
    locale,
    total: accepted + pendingCompatible + pendingPlaceholderIncompatible + missing,
    accepted,
    pendingCompatible,
    pendingPlaceholderIncompatible,
    missing,
})

test('SVG output is deterministic, compact, square-cornered, and newline-stable', () => {
    const summary = target(390, 18, 2, 12)
    const first = renderStatusSvg(summary)
    assert.equal(first, renderStatusSvg(summary))
    assert.equal(first.endsWith('\n'), true)
    assert.equal(first.endsWith('\n\n'), false)
    assert.match(first, /^<svg /u)
    assert.doesNotMatch(
        first,
        /<defs|<g |<text|<script|foreignObject|onload=|onclick=|(?:href|src)=|\brx=/u
    )
})

test('full source and accepted target use only solid Accepted geometry', () => {
    for (const summary of [{ kind: 'source', locale: 'en', total: 422 }, target(422, 0, 0, 0)]) {
        const geometry = calculateSvgGeometry(summary)
        assert.deepEqual(
            geometry.segments.map(({ state, count, start, width }) => ({
                state,
                count,
                start,
                width,
            })),
            [
                { state: 'accepted', count: 422, start: 0, width: 168 },
                { state: 'review', count: 0, start: 168, width: 0 },
                { state: 'missing', count: 0, start: 168, width: 0 },
            ]
        )
        const svg = renderStatusSvg(summary)
        assert.match(svg, /fill="#2DA44E"/u)
        assert.doesNotMatch(svg, /#D4A72C|#E36300|#C94A4A|pattern|line|clipPath/u)
    }
})

test('Review and Missing use plain solid colors in fixed order', () => {
    const review = renderStatusSvg(target(0, 422, 0, 0))
    const missing = renderStatusSvg(target(0, 0, 0, 422))
    assert.match(review, new RegExp(`fill="${REVIEW}"`, 'u'))
    assert.doesNotMatch(review, /#2DA44E|#C94A4A|pattern|line|clipPath/u)
    assert.match(missing, /fill="#C94A4A"/u)
    assert.doesNotMatch(missing, /#2DA44C|#2DA44E|#D4A72C|pattern|line|clipPath/u)
})

test('mixed geometry remains exactly proportional and ends at W', () => {
    const geometry = calculateSvgGeometry(target(390, 20, 0, 12))
    assert.equal(geometry.segments[0].width, (390 * 168) / 422)
    assert.ok(Math.abs(geometry.segments[1].width - (20 * 168) / 422) < 1e-12)
    assert.ok(Math.abs(geometry.segments[2].width - (12 * 168) / 422) < 1e-12)
    assert.ok(
        Math.abs(
            geometry.segments[2].start - (geometry.segments[0].width + geometry.segments[1].width)
        ) < 1e-12
    )
    assert.ok(Math.abs(geometry.segments[2].start + geometry.segments[2].width - 168) < 1e-12)
    const svg = renderStatusSvg(target(390, 20, 0, 12))
    assert.match(svg, new RegExp(`fill="${REVIEW}"`, 'u'))
    assert.match(svg, /fill="#C94A4A"/u)
    assert.doesNotMatch(svg, /pattern|stroke=|<line|clipPath|\brx=/u)
})

test('fractional tiny states remain true proportional segments without overlays', () => {
    const geometry = calculateSvgGeometry(target(420, 1, 0, 1))
    assert.ok(geometry.segments[1].width < 1)
    assert.ok(geometry.segments[2].width < 1)
    assert.ok(Math.abs(geometry.segments[1].width - 168 / 422) < 1e-12)
    assert.ok(Math.abs(geometry.segments[2].width - 168 / 422) < 1e-12)
    const svg = renderStatusSvg(target(420, 1, 0, 1))
    assert.equal((svg.match(/<rect /gu) ?? []).length, 3)
    assert.doesNotMatch(svg, /marker|pattern|<line|clipPath|\brx=/u)
})

test('broad geometry coverage preserves proportional order and exact serialized edges', () => {
    const values = [0, 1, 2, 14, 167, 168, 169, 421, 422, 1000]
    for (const accepted of values) {
        for (const review of values) {
            for (const missing of values) {
                const total = accepted + review + missing
                if (total === 0) continue
                const summary = target(accepted, review, 0, missing)
                const geometry = calculateSvgGeometry(summary)
                const repeated = renderStatusSvg(summary)
                assert.equal(repeated, renderStatusSvg(summary))
                let previousEnd = 0
                for (const segment of geometry.segments) {
                    assert.ok(segment.width >= 0)
                    assert.ok(segment.start >= previousEnd)
                    assert.ok(
                        Math.abs(segment.width - (168 * segment.count) / total) < 1e-9 ||
                            segment ===
                                [...geometry.segments].reverse().find((item) => item.count > 0)
                    )
                    previousEnd = segment.start + segment.width
                }
                assert.equal(previousEnd, 168)

                const rects = [
                    ...repeated.matchAll(/<rect x="([0-9.]+)" y="0" width="([0-9.]+)"/gu),
                ].map(([, x, width]) => ({ x: Number(x), width: Number(width) }))
                const visible = geometry.segments.filter((segment) => segment.count > 0)
                assert.equal(rects.length, visible.length)
                let serializedEnd = 0
                for (const [index, rect] of rects.entries()) {
                    assert.equal(rect.x, Number(visible[index].start.toFixed(3)))
                    assert.ok(rect.width >= 0)
                    assert.ok(Math.abs(rect.width - (168 * visible[index].count) / total) <= 0.001)
                    assert.ok(rect.x >= serializedEnd - 1e-9)
                    serializedEnd = rect.x + rect.width
                }
                assert.equal(serializedEnd, 168)
            }
        }
    }
})

test('canonical locale validation prevents path-like asset identifiers', () => {
    for (const invalid of ['../evil', '..\\evil', 'a/b', 'a\\b', '/absolute', 'C:\\evil']) {
        assert.throws(() => validateLocaleId(invalid), /not a valid locale code|canonical casing/u)
    }
    for (const valid of ['en', 'de', 'ru', 'uk']) {
        assert.doesNotThrow(() => validateLocaleId(valid))
    }
})

test('zero categories emit no geometry and do not invent visible states', () => {
    const svg = renderStatusSvg(target(421, 0, 0, 1))
    assert.equal((svg.match(/<rect /gu) ?? []).length, 2)
    assert.doesNotMatch(svg, new RegExp(`fill="${REVIEW}"`, 'u'))
    assert.match(svg, /fill="#C94A4A"/u)
})

test('XML values are escaped and SVG contains no visible text or external resources', () => {
    const svg = renderStatusSvg(target(1, 0, 0, 0, 'x&<"\''), {
        palette: { accepted: '#A&<"\'' },
    })
    assert.match(svg, /x&amp;&lt;&quot;&apos;/u)
    assert.match(svg, /#A&amp;&lt;&quot;&apos;/u)
    assert.doesNotMatch(
        svg,
        /<text|<image|@import|javascript:|animation|font-face|foreignObject|<script/u
    )
})

test('current summaries render byte-consistent simple assets', () => {
    const summaries = buildStatusSummaries(inspectLocales())
    const directory = mkdtempSync(join(tmpdir(), 'modrex-svg-'))
    const result = generateStatusAssets({ outputDir: directory })
    assert.deepEqual(readdirSync(directory).sort(), ['de.svg', 'en.svg', 'ru.svg', 'uk.svg'])
    for (const summary of [summaries.source, ...summaries.targets]) {
        assert.equal(
            readFileSync(join(directory, `${summary.locale}.svg`), 'utf8'),
            renderStatusSvg(summary)
        )
    }
    assert.equal(result.written.length, 4)
    const second = generateStatusAssets({ outputDir: directory })
    assert.deepEqual(second.written, [])
    for (const summary of [summaries.source, ...summaries.targets]) {
        assert.equal(
            readFileSync(join(STATUS_ASSET_DIR, `${summary.locale}.svg`), 'utf8'),
            renderStatusSvg(summary)
        )
    }
})
