import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildStatusSummaries } from './i18n-presentation.mjs'
import { inspectLocales, I18N_DIR } from './i18n-inspection.mjs'

const SVG_WIDTH = 168
const SVG_HEIGHT = 10
const SVG_PRECISION = 3
const DEFAULT_PALETTE = Object.freeze({
    accepted: '#2DA44E',
    review: '#D4A72C',
    missing: '#C94A4A',
})
const STATES = Object.freeze(['accepted', 'review', 'missing'])

function assertCount(name, value) {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`Invalid SVG count '${name}': ${value}`)
    }
    return value
}

function summaryCounts(summary) {
    if (summary.kind === 'source') {
        assertCount('total', summary.total)
        if (summary.total <= 0) throw new Error('SVG source total must be positive')
        return { accepted: summary.total, review: 0, missing: 0, total: summary.total }
    }
    const pending = assertCount(
        'pending',
        summary.pendingCompatible + summary.pendingPlaceholderIncompatible
    )
    const counts = {
        accepted: assertCount('accepted', summary.accepted),
        review: pending,
        missing: assertCount('missing', summary.missing),
        total: assertCount('total', summary.total),
    }
    if (counts.total <= 0) throw new Error('SVG target total must be positive')
    if (counts.accepted + counts.review + counts.missing !== counts.total) {
        throw new Error(`SVG count invariant failed for '${summary.locale}'`)
    }
    return counts
}

function formatNumber(value) {
    if (!Number.isFinite(value)) throw new Error(`Invalid SVG number: ${value}`)
    const rounded = Number(value.toFixed(SVG_PRECISION))
    return Object.is(rounded, -0) ? '0' : String(rounded)
}

export function escapeXml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;')
}

export function calculateSvgGeometry(summary, width = SVG_WIDTH) {
    assertCount('width', width)
    if (width <= 0) throw new Error(`SVG width must be positive: ${width}`)
    const counts = summaryCounts(summary)
    let start = 0
    const segments = STATES.map((state) => {
        const count = counts[state]
        const segment = { state, count, start, width: (width * count) / counts.total }
        start += segment.width
        return segment
    })
    const finalSegment = [...segments].reverse().find((segment) => segment.count > 0)
    if (finalSegment) finalSegment.width = width - finalSegment.start
    return { width, height: SVG_HEIGHT, counts, segments }
}

function paletteValues(palette) {
    const values = { ...DEFAULT_PALETTE, ...palette }
    for (const state of ['accepted', 'review', 'missing']) {
        if (typeof values[state] !== 'string' || values[state].length === 0) {
            throw new Error(`Invalid SVG palette value '${state}'`)
        }
    }
    return values
}

function segmentFill(state, palette) {
    return palette[state]
}

function serializeSegment(segment, palette, serializedStart, serializedWidth) {
    if (segment.count === 0) return ''
    return `<rect x="${formatNumber(serializedStart)}" y="0" width="${formatNumber(serializedWidth)}" height="${SVG_HEIGHT}" fill="${escapeXml(segmentFill(segment.state, palette))}"/>`
}

export function renderStatusSvg(summary, options = {}) {
    const geometry = calculateSvgGeometry(summary, options.width ?? SVG_WIDTH)
    const palette = paletteValues(options.palette)
    const visibleSegments = geometry.segments.filter((segment) => segment.count > 0)
    const segments = visibleSegments
        .map((segment, index) => {
            const serializedStart = Number(formatNumber(segment.start))
            const nextStart =
                index === visibleSegments.length - 1
                    ? geometry.width
                    : Number(formatNumber(visibleSegments[index + 1].start))
            return serializeSegment(segment, palette, serializedStart, nextStart - serializedStart)
        })
        .join('')
    const safeLocale = escapeXml(summary.locale)
    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${formatNumber(geometry.width)}" height="${SVG_HEIGHT}" viewBox="0 0 ${formatNumber(geometry.width)} ${SVG_HEIGHT}" role="img" aria-label="${safeLocale} translation status">`,
        segments,
        '</svg>',
        '',
    ].join('\n')
}

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
export const STATUS_ASSET_DIR = resolve(SCRIPT_ROOT, 'assets/i18n/status')

export function generateStatusAssets({ i18nDir = I18N_DIR, outputDir = STATUS_ASSET_DIR } = {}) {
    const inspection = inspectLocales(i18nDir)
    const summaries = buildStatusSummaries(inspection)
    const all = [summaries.source, ...summaries.targets]
    mkdirSync(outputDir, { recursive: true })
    const written = []
    for (const summary of all) {
        const filePath = resolve(outputDir, `${summary.locale}.svg`)
        const svg = renderStatusSvg(summary)
        if (!existsSync(filePath) || readFileSync(filePath, 'utf8') !== svg) {
            writeFileSync(filePath, svg, 'utf8')
            written.push(filePath)
        }
    }
    return { outputDir, written, summaries }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    try {
        const result = generateStatusAssets()
        process.stdout.write(
            `i18n: rendered ${result.summaries.targets.length + 1} SVG status asset(s) in ${STATUS_ASSET_DIR}\n`
        )
    } catch (error) {
        process.stderr.write(`i18n: SVG rendering failed: ${error.message}\n`)
        process.exitCode = 1
    }
}
