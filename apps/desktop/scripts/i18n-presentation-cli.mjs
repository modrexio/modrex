import { placeholderContract } from '../src/shared/i18n-values.js'
import { deriveTargetStatus } from './i18n-presentation.mjs'

const PREFERRED_BAR_WIDTH = 40
const MINIMUM_BAR_WIDTH = 32
const STATES = ['accepted', 'review', 'missing']
const STATUS_COLUMN_WIDTH = 8
const LABEL_SEPARATOR_WIDTH = 1
const STATUS_SEPARATOR_WIDTH = 1
const BAR_TRAILING_SPACE_WIDTH = 1

export function detectCliCapabilities({ stdout = process.stdout, env = process.env } = {}) {
    const ci = env.CI !== undefined && env.CI !== '' && env.CI !== '0'
    const tty = stdout.isTTY === true
    const dumb = env.TERM === 'dumb'
    const noColor =
        Object.hasOwn(env, 'NO_COLOR') ||
        (env.NODE_DISABLE_COLORS !== undefined && env.NODE_DISABLE_COLORS !== '0') ||
        !tty ||
        ci ||
        dumb
    return {
        ci,
        tty,
        dumb,
        color: !noColor,
        rich: tty && !ci && !dumb,
        columns: Number.isFinite(stdout.columns) ? stdout.columns : 0,
    }
}

function identity(value) {
    return value
}

export function renderPlaceholderText(value, styles) {
    if (!styles) return value
    const remaining = new Map()
    for (const name of placeholderContract(value)) {
        remaining.set(name, (remaining.get(name) ?? 0) + 1)
    }
    return value.replace(/\{(\w+)\}/gu, (token, name) => {
        const count = remaining.get(name) ?? 0
        if (count === 0) return token
        remaining.set(name, count - 1)
        return styles.placeholder(token)
    })
}

export function createSemanticStyles(color) {
    if (!color) {
        return Object.fromEntries(
            [
                'heading',
                'key',
                'command',
                'placeholder',
                'accepted',
                'review',
                'missing',
                'warning',
                'error',
                'secondary',
            ].map((name) => [name, identity])
        )
    }
    const ansi = {
        heading: '\u001b[1m',
        key: '\u001b[36m',
        command: '\u001b[36m',
        placeholder: '\u001b[36m',
        accepted: '\u001b[32m',
        review: '\u001b[33m',
        missing: '\u001b[31m',
        warning: '\u001b[33m',
        error: '\u001b[1;31m',
        secondary: '\u001b[2m',
    }
    return Object.fromEntries(
        Object.entries(ansi).map(([name, code]) => [name, (value) => `${code}${value}\u001b[0m`])
    )
}

export function allocateStatusBar(summary, width = PREFERRED_BAR_WIDTH) {
    if (!Number.isInteger(width) || width < MINIMUM_BAR_WIDTH) {
        throw new Error(`Status bar width must be at least ${MINIMUM_BAR_WIDTH} cells`)
    }
    const counts = [summary.accepted, summary.pending, summary.missing]
    const nonzero = counts.filter((count) => count > 0).length
    const cells = counts.map((count) => (count > 0 ? 1 : 0))
    const remaining = width - nonzero
    const quotas = counts.map((count) => (remaining * count) / summary.total)
    const floors = quotas.map((quota) => Math.floor(quota))
    for (let index = 0; index < cells.length; index += 1) cells[index] += floors[index]
    let leftover = width - cells.reduce((sum, count) => sum + count, 0)
    const order = quotas
        .map((quota, index) => ({ index, remainder: quota - Math.floor(quota) }))
        .sort((left, right) => right.remainder - left.remainder || left.index - right.index)
    for (const { index } of order) {
        if (leftover === 0) break
        cells[index] += 1
        leftover -= 1
    }
    if (cells.reduce((sum, count) => sum + count, 0) !== width) {
        throw new Error(`Status bar allocation did not produce ${width} cells`)
    }
    return cells
}

const BAR_GLYPH = '━'

export function renderStatusBar(summary, styles, width = PREFERRED_BAR_WIDTH) {
    const cells = allocateStatusBar(summary, width)
    return cells
        .map((count, index) => {
            if (count === 0) return ''
            const text = BAR_GLYPH.repeat(count)
            if (!styles) return text
            return styles.bar(STATES[index], text)
        })
        .join('')
}

function compactCounts(status) {
    const counts = []
    if (status.accepted > 0) counts.push(`${status.accepted} accepted`)
    if (status.pending > 0) counts.push(`${status.pending} review`)
    if (status.missing > 0) counts.push(`${status.missing} missing`)
    if (status.usesEnglishFallback > 0) counts.push(`fallback=${status.usesEnglishFallback}`)
    return counts.join(', ')
}

function rowCounts(status) {
    return status.kind === 'source' ? `${status.total} source` : compactCounts(status)
}

function rowWidthWithoutBar(status) {
    return (
        status.labelWidth +
        LABEL_SEPARATOR_WIDTH +
        STATUS_COLUMN_WIDTH +
        STATUS_SEPARATOR_WIDTH +
        rowCounts(status).length
    )
}

export function resolveSharedBarWidth(rows, columns) {
    if (rows.length === 0) return 0
    const maxNonBarWidth = Math.max(...rows.map(rowWidthWithoutBar))
    const available = columns - maxNonBarWidth - BAR_TRAILING_SPACE_WIDTH
    if (available >= PREFERRED_BAR_WIDTH) return PREFERRED_BAR_WIDTH
    if (available >= MINIMUM_BAR_WIDTH) return available
    return 0
}

function renderRichRow(label, status, styles, width) {
    const boldLabel = styles.heading(label.padEnd(status.labelWidth))
    const bar = width > 0 ? `${renderStatusBar(status, styles, width)} ` : ''
    const counts = rowCounts(status)
    return `${boldLabel} ${bar}${status.label.padEnd(STATUS_COLUMN_WIDTH)} ${counts}`.trimEnd()
}

function renderPlainRow(label, status) {
    const counts = compactCounts(status)
    return `${label}: ${status.label}; ${status.kind === 'source' ? `source=${status.total}` : counts}`
}

function createBarStyles(color) {
    if (!color) return { bar: (_state, text) => text }
    const foregrounds = { accepted: '\u001b[32m', review: '\u001b[33m', missing: '\u001b[31m' }
    return {
        bar: (state, text) => `${foregrounds[state]}${text}\u001b[0m`,
    }
}

function statusRows(summaries, nativeName) {
    const source = {
        ...summaries.source,
        accepted: summaries.source.total,
        pending: 0,
        missing: 0,
        usesEnglishFallback: 0,
        label: 'Complete',
        kind: 'source',
    }
    const targets = summaries.targets.map((summary) => ({
        ...deriveTargetStatus(summary),
        kind: 'target',
    }))
    const labels = [source, ...targets].map(
        (status) => `${nativeName(status.locale)} (${status.locale})`
    )
    const labelWidth = Math.max(...labels.map((label) => label.length))
    return [source, ...targets].map((status, index) => ({
        ...status,
        labelWidth,
        displayLabel: labels[index],
    }))
}

export function renderStatus({
    summaries,
    capabilities,
    nativeName = (id) => id,
    stdout = process.stdout,
} = {}) {
    const styles = {
        ...createSemanticStyles(capabilities.color),
        ...createBarStyles(capabilities.color),
    }
    const rows = statusRows(summaries, nativeName)
    const richEligible = capabilities.rich && capabilities.color
    const barWidth = richEligible ? resolveSharedBarWidth(rows, capabilities.columns) : 0
    const lines = rows.map((status) => {
        if (richEligible) {
            return renderRichRow(status.displayLabel, status, styles, barWidth)
        }
        return renderPlainRow(status.displayLabel, status)
    })
    stdout.write(`${lines.join('\n')}\n`)
}
