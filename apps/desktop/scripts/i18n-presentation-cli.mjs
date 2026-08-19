import { deriveTargetStatus, targetFallbackLabel } from './i18n-presentation.mjs'

const BAR_WIDTH = 24
const STATES = [
    ['accepted', '='],
    ['review', '?'],
    ['missing', '!'],
]

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
        bar: tty && !ci && !dumb && Number.isFinite(stdout.columns) && stdout.columns >= 60,
    }
}

function identity(value) {
    return value
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

export function allocateStatusBar(summary) {
    const counts = [summary.accepted, summary.pending, summary.missing]
    const nonzero = counts.filter((count) => count > 0).length
    const cells = counts.map((count) => (count > 0 ? 1 : 0))
    const remaining = BAR_WIDTH - nonzero
    const quotas = counts.map((count) => (remaining * count) / summary.total)
    const floors = quotas.map((quota) => Math.floor(quota))
    for (let index = 0; index < cells.length; index += 1) cells[index] += floors[index]
    let leftover = BAR_WIDTH - cells.reduce((sum, count) => sum + count, 0)
    const order = quotas
        .map((quota, index) => ({ index, remainder: quota - Math.floor(quota) }))
        .sort((left, right) => right.remainder - left.remainder || left.index - right.index)
    for (const { index } of order) {
        if (leftover === 0) break
        cells[index] += 1
        leftover -= 1
    }
    if (cells.reduce((sum, count) => sum + count, 0) !== BAR_WIDTH) {
        throw new Error('Status bar allocation did not produce 24 cells')
    }
    return cells
}

export function renderStatusBar(summary, styles) {
    const cells = allocateStatusBar(summary)
    const segments = cells.map((count, index) => {
        const text = STATES[index][1].repeat(count)
        if (!styles) return text
        return styles[STATES[index][0]](text)
    })
    return `[${segments.join('')}]`
}

function targetLine(summary, styles) {
    const status = deriveTargetStatus(summary)
    const counts = `${status.accepted} accepted · ${status.pending} review · ${status.missing} missing`
    return {
        status,
        counts,
    }
}

function targetActions(status, styles) {
    const actions = []
    if (status.missing > 0)
        actions.push(styles.command(`Next: pnpm i18n:translate ${status.locale}`))
    if (status.pending > 0) actions.push(styles.command(`Next: pnpm i18n:review ${status.locale}`))
    return actions
}

export function renderStatus({
    summaries,
    capabilities,
    nativeName = (id) => id,
    stdout = process.stdout,
} = {}) {
    const styles = createSemanticStyles(capabilities.color)
    const lines = []
    const source = summaries.source
    if (capabilities.rich) {
        lines.push(
            `${styles.heading(`${nativeName(source.locale)} (${source.locale}) — Complete`)}`
        )
        if (capabilities.bar) lines.push(styles.accepted(`[${'='.repeat(BAR_WIDTH)}]`))
        lines.push(`Valid source: ${source.total}`)
    } else {
        lines.push(
            `${nativeName(source.locale)} (${source.locale}): Complete; valid-source=${source.total} total=${source.total}`
        )
    }
    for (const summary of summaries.targets) {
        const line = targetLine(summary, styles)
        const status = line.status
        if (capabilities.rich) {
            lines.push(
                '',
                `${styles.heading(`${nativeName(summary.locale)} (${summary.locale}) — ${status.label}`)}`
            )
            if (capabilities.bar) lines.push(renderStatusBar(status, styles))
            lines.push(`${line.counts}`)
            if (status.usesEnglishFallback > 0)
                lines.push(targetFallbackLabel(status.usesEnglishFallback))
            lines.push(...targetActions(status, styles))
        } else {
            lines.push(
                '',
                `${nativeName(summary.locale)} (${summary.locale}): ${status.label}; accepted=${status.accepted} review=${status.pending} fallback=${status.usesEnglishFallback} missing=${status.missing} total=${status.total}`
            )
            if (status.usesEnglishFallback > 0)
                lines.push(targetFallbackLabel(status.usesEnglishFallback))
            lines.push(...targetActions(status, styles))
        }
    }
    stdout.write(`${lines.join('\n')}\n`)
}
