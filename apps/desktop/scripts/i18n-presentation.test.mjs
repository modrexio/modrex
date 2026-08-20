import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
    buildSourceStatusSummary,
    buildStatusSummaries,
    buildTargetStatusSummary,
    deriveTargetStatus,
    formatPresentationPercentage,
} from './i18n-presentation.mjs'
import {
    allocateStatusBar,
    detectCliCapabilities,
    renderStatus,
    renderStatusBar,
    resolveSharedBarWidth,
} from './i18n-presentation-cli.mjs'
import { inspectLocales, runI18nStatus } from './check-i18n.mjs'

function inspection(sourceCount, locales = []) {
    return {
        sourceErrors: [],
        totalCount: sourceCount,
        locales,
    }
}

function locale(id, values) {
    return {
        id,
        errors: [],
        acceptedCount: values.accepted ?? 0,
        pendingCount: values.pending ?? 0,
        pendingPlaceholderIncompatibleCount: values.fallback ?? 0,
        missingCount: values.missing ?? 0,
    }
}

function outputStream(capabilities = {}) {
    let value = ''
    return {
        stream: {
            ...capabilities,
            write(chunk) {
                value += chunk
            },
        },
        value: () => value,
    }
}

const ANSI_PATTERN = /\[[0-9;]*m/gu

function stripAnsi(text) {
    return text.replace(ANSI_PATTERN, '')
}

test('source summary requires valid positive English source', () => {
    assert.deepEqual(buildSourceStatusSummary(inspection(3)), {
        kind: 'source',
        locale: 'en',
        total: 3,
    })
    assert.throws(() => buildSourceStatusSummary({ sourceErrors: ['bad'], totalCount: 3 }))
    assert.throws(() => buildSourceStatusSummary(inspection(0)))
})

test('target summary derives compatible, incompatible, missing, and translated counts', () => {
    const summary = deriveTargetStatus(
        buildTargetStatusSummary(
            locale('de', { accepted: 2, pending: 2, fallback: 1, missing: 1 }),
            5
        )
    )
    assert.equal(summary.pendingCompatible, 1)
    assert.equal(summary.pending, 2)
    assert.equal(summary.translated, 4)
    assert.equal(summary.usesEnglishFallback, 1)
    assert.equal(summary.translatedPercentage, '80%')
    assert.equal(summary.label, '80%')
})

test('complete is reserved for fully accepted targets', () => {
    assert.equal(
        deriveTargetStatus(buildTargetStatusSummary(locale('de', { accepted: 5 }), 5)).label,
        'Complete'
    )
    assert.equal(
        deriveTargetStatus(buildTargetStatusSummary(locale('de', { accepted: 4, pending: 1 }), 5))
            .label,
        '100%'
    )
})

test('summary invariant rejects inconsistent counts', () => {
    assert.throws(() => buildTargetStatusSummary(locale('de', { accepted: 2 }), 3))
    assert.throws(() =>
        buildStatusSummaries(inspection(3, [{ ...locale('de', { accepted: 2 }), errors: ['bad'] }]))
    )
})

test('percentage formatting rounds to one decimal and suppresses zero decimals', () => {
    assert.equal(formatPresentationPercentage(0, 10), '0%')
    assert.equal(formatPresentationPercentage(39, 40), '97.5%')
    assert.equal(formatPresentationPercentage(1, 3), '33.3%')
    assert.equal(formatPresentationPercentage(10, 10), '100%')
})

test('capabilities report context-free TTY, color, and column facts only', () => {
    const tty = { isTTY: true, columns: 80 }
    assert.deepEqual(detectCliCapabilities({ stdout: tty, env: {} }), {
        ci: false,
        tty: true,
        dumb: false,
        color: true,
        rich: true,
        columns: 80,
    })
    assert.equal(detectCliCapabilities({ stdout: tty, env: { NO_COLOR: '' } }).color, false)
    assert.equal(
        detectCliCapabilities({ stdout: tty, env: { NODE_DISABLE_COLORS: '1' } }).color,
        false
    )
    assert.equal(
        detectCliCapabilities({ stdout: tty, env: { NODE_DISABLE_COLORS: '0' } }).color,
        true
    )
    assert.equal(detectCliCapabilities({ stdout: tty, env: { CI: 'true' } }).rich, false)
    assert.equal(detectCliCapabilities({ stdout: tty, env: { CI: 'true' } }).color, false)
    assert.equal(detectCliCapabilities({ stdout: tty, env: { TERM: 'dumb' } }).rich, false)
    assert.equal(detectCliCapabilities({ stdout: {}, env: {} }).rich, false)
    assert.equal(detectCliCapabilities({ stdout: {}, env: {} }).columns, 0)
    for (const columns of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.equal(
            detectCliCapabilities({ stdout: { isTTY: true, columns }, env: {} }).columns,
            0
        )
    }
})

test('status bars use exact deterministic 40-cell allocation and state order', () => {
    const cases = [
        { accepted: 24, pending: 0, missing: 0 },
        { accepted: 0, pending: 24, missing: 0 },
        { accepted: 0, pending: 0, missing: 24 },
        { accepted: 421, pending: 0, missing: 1 },
        { accepted: 422, pending: 1, missing: 1 },
    ]
    for (const counts of cases) {
        const summary = { ...counts, total: counts.accepted + counts.pending + counts.missing }
        const cells = allocateStatusBar(summary)
        assert.equal(
            cells.reduce((sum, count) => sum + count, 0),
            40
        )
        assert.equal(renderStatusBar(summary).length, 40)
        for (const [index, count] of [counts.accepted, counts.pending, counts.missing].entries()) {
            if (count > 0) assert.ok(cells[index] > 0)
        }
    }
})

test('resolveSharedBarWidth accounts for the full row: preferred, reduced, minimum, and below-minimum', () => {
    const row = { kind: 'source', labelWidth: 12, total: 422 }
    // nonBarWidth = labelWidth(12) + 1 + STATUS_COLUMN_WIDTH(8) + 1 + "422 source".length(10) = 32
    // available = columns - nonBarWidth - 1
    assert.equal(resolveSharedBarWidth([row], 73), 40) // available = 40, exactly preferred
    assert.equal(resolveSharedBarWidth([row], 100), 40) // extra room still caps at 40
    assert.equal(resolveSharedBarWidth([row], 70), 37) // reduced, mid-range: no jump to 32
    assert.equal(resolveSharedBarWidth([row], 65), 32) // exact minimum
    assert.equal(resolveSharedBarWidth([row], 64), 0) // one column below minimum viability
    assert.equal(resolveSharedBarWidth([row], 73), resolveSharedBarWidth([row], 73))
})

test('resolveSharedBarWidth uses the worst-case row so all locales share one bar width', () => {
    const shortRow = { kind: 'source', labelWidth: 12, total: 422 }
    const longRow = {
        kind: 'target',
        labelWidth: 12,
        accepted: 400,
        pending: 13,
        missing: 9,
        usesEnglishFallback: 3,
    }
    // longRow counts = "400 accepted, 13 review, 9 missing, fallback=3" (46 chars)
    // its nonBarWidth = 12 + 1 + 8 + 1 + 46 = 68, dominating the short row's 32
    assert.equal(resolveSharedBarWidth([shortRow, longRow], 100), 0) // longRow still too wide
    assert.equal(resolveSharedBarWidth([shortRow, longRow], 101), 32) // longRow's floor governs
    assert.equal(resolveSharedBarWidth([shortRow], 101), 40) // shortRow alone would fit 40 here
    assert.equal(resolveSharedBarWidth([shortRow, longRow], 200), 40)
})

test('resolveSharedBarWidth never returns a width below the approved minimum or above the preferred width', () => {
    const row = { kind: 'source', labelWidth: 15, total: 422 }
    for (let columns = 0; columns <= 200; columns += 1) {
        const width = resolveSharedBarWidth([row], columns)
        assert.ok(width === 0 || (width >= 32 && width <= 40))
    }
})

test('rich bars use ordered ANSI foreground segments for all nonzero states', () => {
    const stream = outputStream({ isTTY: true, columns: 100 })
    renderStatus({
        summaries: {
            source: { kind: 'source', locale: 'en', total: 10 },
            targets: [
                {
                    kind: 'target',
                    locale: 'de',
                    total: 10,
                    accepted: 4,
                    pendingCompatible: 3,
                    pendingPlaceholderIncompatible: 0,
                    missing: 3,
                },
            ],
        },
        capabilities: detectCliCapabilities({ stdout: stream.stream, env: {} }),
        stdout: stream.stream,
    })
    const output = stream.value()
    const green = output.indexOf('[32m')
    const yellow = output.indexOf('[33m')
    const red = output.indexOf('[31m')
    assert.ok(green >= 0 && green < yellow && yellow < red)
    const stripped = stripAnsi(output)
    assert.doesNotMatch(output, /\[4[0-7]m/u)
    assert.doesNotMatch(stripped, /[[\]?!]/u)
    assert.match(stripped, /━/u)
    assert.doesNotMatch(output, /[█▓▒▄▀]/u)
})

test('plain and rich status renderers preserve the same semantic facts', () => {
    const summaries = {
        source: { kind: 'source', locale: 'en', total: 422 },
        targets: [
            {
                kind: 'target',
                locale: 'de',
                total: 422,
                accepted: 420,
                pendingCompatible: 1,
                pendingPlaceholderIncompatible: 1,
                missing: 0,
            },
        ],
    }
    const plain = outputStream()
    renderStatus({
        summaries,
        capabilities: detectCliCapabilities({ stdout: plain.stream, env: {} }),
        nativeName: (id) => (id === 'en' ? 'English' : 'Deutsch'),
        stdout: plain.stream,
    })
    assert.doesNotMatch(plain.value(), /\[/u)
    assert.doesNotMatch(plain.value(), /\[=+/u)
    assert.match(plain.value(), /Deutsch \(de\): 100%; 420 accepted, 2 review, fallback=1/u)
    assert.doesNotMatch(plain.value(), /uses English fallback/u)

    const rich = outputStream({ isTTY: true, columns: 100 })
    renderStatus({
        summaries,
        capabilities: detectCliCapabilities({ stdout: rich.stream, env: {} }),
        nativeName: (id) => (id === 'en' ? 'English' : 'Deutsch'),
        stdout: rich.stream,
    })
    assert.match(rich.value(), /\[/u)
    const richText = stripAnsi(rich.value())
    assert.doesNotMatch(richText, /[[\]?!]/u)
    assert.match(richText, /Deutsch \(de\).*━{40}.*100%.*420 accepted, 2 review, fallback=1/u)
})

test('a wide TTY with NO_COLOR falls back to compact bar-free rows, not an uncolored bar', () => {
    const summaries = {
        source: { kind: 'source', locale: 'en', total: 10 },
        targets: [
            {
                kind: 'target',
                locale: 'de',
                total: 10,
                accepted: 10,
                pendingCompatible: 0,
                pendingPlaceholderIncompatible: 0,
                missing: 0,
            },
        ],
    }
    for (const env of [{ NO_COLOR: '' }, { NODE_DISABLE_COLORS: '1' }]) {
        const stream = outputStream({ isTTY: true, columns: 120 })
        const capabilities = detectCliCapabilities({ stdout: stream.stream, env })
        assert.equal(capabilities.rich, true)
        assert.equal(capabilities.color, false)
        renderStatus({ summaries, capabilities, stdout: stream.stream })
        assert.doesNotMatch(stream.value(), /\[/u)
        assert.doesNotMatch(stream.value(), /━/u)
        assert.doesNotMatch(stream.value(), /[[\]?!]/u)
        assert.match(stream.value(), /en \(en\): Complete; source=10/u)
        assert.match(stream.value(), /de \(de\): Complete; 10 accepted/u)
    }
})

test('invalid English status emits no partial presentation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'modrex-i18n-status-invalid-'))
    try {
        mkdirSync(directory, { recursive: true })
        writeFileSync(join(directory, 'en.json'), JSON.stringify({ key: '' }))
        writeFileSync(join(directory, 'de.json'), JSON.stringify({ key: 'x' }))
        const stdout = outputStream()
        const stderr = outputStream()
        assert.equal(
            runI18nStatus({
                i18nDir: directory,
                stdout: stdout.stream,
                stderr: stderr.stream,
                env: {},
            }),
            1
        )
        assert.equal(stdout.value(), '')
        assert.match(stderr.value(), /Source validation failed/u)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('absent and scaffold target leaves both count as Missing', () => {
    for (const target of [{}, { key: '! English' }]) {
        const directory = mkdtempSync(join(tmpdir(), 'modrex-i18n-status-missing-'))
        try {
            writeFileSync(join(directory, 'en.json'), JSON.stringify({ key: 'English' }))
            writeFileSync(join(directory, 'de.json'), JSON.stringify(target))
            const summaries = buildStatusSummaries(inspectLocales(directory))
            const summary = summaries.targets[0]
            assert.equal(summary.accepted, 0)
            assert.equal(summary.pendingCompatible, 0)
            assert.equal(summary.pendingPlaceholderIncompatible, 0)
            assert.equal(summary.missing, 1)
        } finally {
            rmSync(directory, { recursive: true, force: true })
        }
    }
})

test('invalid target status fails before rendering any locale', () => {
    const directory = mkdtempSync(join(tmpdir(), 'modrex-i18n-status-target-invalid-'))
    try {
        writeFileSync(join(directory, 'en.json'), JSON.stringify({ key: 'English' }))
        writeFileSync(join(directory, 'de.json'), JSON.stringify({ key: 'Deutsch' }))
        writeFileSync(join(directory, 'ru.json'), JSON.stringify({ key: 42 }))
        const stdout = outputStream()
        const stderr = outputStream()
        assert.equal(
            runI18nStatus({ i18nDir: directory, stdout: stdout.stream, stderr: stderr.stream }),
            1
        )
        assert.equal(stdout.value(), '')
        assert.match(stderr.value(), /Target validation failed/u)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('status is independent of Git history', () => {
    const directory = mkdtempSync(join(tmpdir(), 'modrex-i18n-status-no-git-'))
    try {
        writeFileSync(join(directory, 'en.json'), JSON.stringify({ key: 'English' }))
        writeFileSync(join(directory, 'de.json'), JSON.stringify({ key: 'Deutsch' }))
        const stdout = outputStream()
        const stderr = outputStream()
        assert.equal(
            runI18nStatus({ i18nDir: directory, stdout: stdout.stream, stderr: stderr.stream }),
            0
        )
        assert.match(stdout.value(), /English \(en\): Complete/u)
        assert.equal(stderr.value(), '')
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('rich bar boundaries retain styling and omit only the bar', () => {
    const summary = {
        source: { kind: 'source', locale: 'en', total: 10 },
        targets: [
            {
                kind: 'target',
                locale: 'de',
                total: 10,
                accepted: 9,
                pendingCompatible: 0,
                pendingPlaceholderIncompatible: 0,
                missing: 1,
            },
        ],
    }
    for (const columns of [80]) {
        const stream = outputStream({ isTTY: true, columns })
        renderStatus({
            summaries: summary,
            capabilities: detectCliCapabilities({ stdout: stream.stream, env: {} }),
            stdout: stream.stream,
        })
        assert.match(stream.value(), /\[32m/u)
    }
    for (const columns of [59, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
        const stream = outputStream({ isTTY: true, columns })
        renderStatus({
            summaries: summary,
            capabilities: detectCliCapabilities({ stdout: stream.stream, env: {} }),
            stdout: stream.stream,
        })
        const plainText = stripAnsi(stream.value())
        assert.doesNotMatch(plainText, /[[\]?!]/u)
        assert.match(plainText, /9 accepted, 1 missing/u)
    }
})

test('disabling color also disables the bar even on an otherwise-eligible wide TTY', () => {
    const summaries = {
        source: { kind: 'source', locale: 'en', total: 10 },
        targets: [
            {
                kind: 'target',
                locale: 'de',
                total: 10,
                accepted: 9,
                pendingCompatible: 0,
                pendingPlaceholderIncompatible: 0,
                missing: 1,
            },
        ],
    }
    const stdout = { isTTY: true, columns: 200 }
    for (const env of [
        { NO_COLOR: '' },
        { NO_COLOR: '1' },
        { NODE_DISABLE_COLORS: '1' },
        { NODE_DISABLE_COLORS: 'anything' },
    ]) {
        const capabilities = detectCliCapabilities({ stdout, env })
        assert.equal(capabilities.rich, true)
        assert.equal(capabilities.color, false)
        const stream = outputStream(stdout)
        renderStatus({ summaries, capabilities, stdout: stream.stream })
        assert.doesNotMatch(stream.value(), /\[/u)
        assert.doesNotMatch(stream.value(), /━/u)
    }
    const restored = detectCliCapabilities({ stdout, env: { NODE_DISABLE_COLORS: '0' } })
    assert.equal(restored.color, true)
    const restoredStream = outputStream(stdout)
    renderStatus({ summaries, capabilities: restored, stdout: restoredStream.stream })
    assert.match(restoredStream.value(), /\[32m/u)
    assert.match(restoredStream.value(), /━/u)
})

test('no supported capability state renders a bar without color', () => {
    const summaries = {
        source: { kind: 'source', locale: 'en', total: 422 },
        targets: [
            {
                kind: 'target',
                locale: 'de',
                total: 422,
                accepted: 420,
                pendingCompatible: 2,
                pendingPlaceholderIncompatible: 0,
                missing: 0,
            },
        ],
    }
    for (const columns of [0, 40, 80, 120, 200]) {
        for (const env of [{ NO_COLOR: '' }, { CI: 'true' }, { TERM: 'dumb' }]) {
            const stream = outputStream({ isTTY: true, columns })
            const capabilities = detectCliCapabilities({ stdout: stream.stream, env })
            renderStatus({ summaries, capabilities, stdout: stream.stream })
            assert.doesNotMatch(stream.value(), /━/u)
            assert.doesNotMatch(stream.value(), /\[/u)
        }
    }
})

test('largest-remainder ties use Accepted, Review, Missing order', () => {
    assert.deepEqual(
        allocateStatusBar({ accepted: 1, pending: 2, missing: 1, total: 4 }),
        [10, 20, 10]
    )
    assert.equal(renderStatusBar({ accepted: 1, pending: 2, missing: 1, total: 4 }).length, 40)
})

test('tiny nonzero Review and Missing states remain visible', () => {
    for (const counts of [
        { accepted: 421, pending: 1, missing: 0 },
        { accepted: 421, pending: 0, missing: 1 },
        { accepted: 420, pending: 1, missing: 1 },
    ]) {
        const summary = { ...counts, total: 422 }
        const bar = renderStatusBar(summary)
        assert.equal(bar.length, 40)
        assert.match(bar, /^━+$/u)
        const cells = allocateStatusBar(summary)
        if (counts.pending > 0) assert.ok(cells[1] > 0)
        if (counts.missing > 0) assert.ok(cells[2] > 0)
    }
})

test('the real German/Russian tiny-Review fixture (420/2/0/422) remains visible at both preferred and minimum width', () => {
    const summary = { accepted: 420, pending: 2, missing: 0, total: 422 }
    for (const width of [40, 32]) {
        const cells = allocateStatusBar(summary, width)
        assert.equal(cells[0] + cells[1] + cells[2], width)
        assert.ok(cells[1] > 0, `Review must receive a visible cell at width ${width}`)
        assert.equal(cells[2], 0)
    }
    const styles = { bar: (state, text) => `<${state}:${text}>` }
    for (const width of [40, 32]) {
        const rendered = renderStatusBar(summary, styles, width)
        assert.match(rendered, /<review:━+>/u)
        assert.match(rendered, /<accepted:━+>/u)
        assert.doesNotMatch(rendered, /<missing:/u)
    }
})

test('status bar allocation satisfies deterministic properties across count triples', () => {
    for (let accepted = 0; accepted <= 15; accepted += 1) {
        for (let pending = 0; pending <= 15; pending += 1) {
            for (let missing = 0; missing <= 15; missing += 1) {
                const total = accepted + pending + missing
                if (total === 0) continue
                const summary = { accepted, pending, missing, total }
                const first = renderStatusBar(summary)
                const second = renderStatusBar(summary)
                assert.equal(first, second)
                assert.equal(first.length, 40)
                assert.match(first, /^━+$/u)
            }
        }
    }
})

test('fallback wording and stable plain fallback field are correct', () => {
    for (const [count] of [[0], [1], [2]]) {
        const stream = outputStream()
        renderStatus({
            summaries: {
                source: { kind: 'source', locale: 'en', total: 2 },
                targets: [
                    {
                        kind: 'target',
                        locale: 'de',
                        total: 2,
                        accepted: 2 - count,
                        pendingCompatible: 0,
                        pendingPlaceholderIncompatible: count,
                        missing: 0,
                    },
                ],
            },
            capabilities: detectCliCapabilities({ stdout: stream.stream, env: {} }),
            stdout: stream.stream,
        })
        if (count > 0) assert.match(stream.value(), new RegExp(`fallback=${count}`))
        else assert.doesNotMatch(stream.value(), /fallback=/u)
        assert.doesNotMatch(stream.value(), /uses English fallback/u)
    }
})

test('status rows never include next-action recommendations', () => {
    const output = outputStream()
    renderStatus({
        summaries: {
            source: { kind: 'source', locale: 'en', total: 2 },
            targets: [
                {
                    kind: 'target',
                    locale: 'de',
                    total: 2,
                    accepted: 0,
                    pendingCompatible: 1,
                    pendingPlaceholderIncompatible: 0,
                    missing: 1,
                },
            ],
        },
        capabilities: detectCliCapabilities({ stdout: output.stream, env: {} }),
        stdout: output.stream,
    })
    assert.doesNotMatch(output.value(), /Next:|pnpm i18n:(?:translate|review)/u)
})

test('rich output renders exactly one logical line per locale summary', () => {
    const summaries = {
        source: { kind: 'source', locale: 'en', total: 422 },
        targets: [
            {
                kind: 'target',
                locale: 'de',
                total: 422,
                accepted: 420,
                pendingCompatible: 2,
                pendingPlaceholderIncompatible: 0,
                missing: 0,
            },
            {
                kind: 'target',
                locale: 'ru',
                total: 422,
                accepted: 420,
                pendingCompatible: 2,
                pendingPlaceholderIncompatible: 0,
                missing: 0,
            },
            {
                kind: 'target',
                locale: 'uk',
                total: 422,
                accepted: 422,
                pendingCompatible: 0,
                pendingPlaceholderIncompatible: 0,
                missing: 0,
            },
        ],
    }
    const nativeName = (id) =>
        ({ en: 'English', de: 'Deutsch', ru: 'Русский', uk: 'Українська' })[id] ?? id
    const stream = outputStream({ isTTY: true, columns: 120 })
    renderStatus({
        summaries,
        capabilities: detectCliCapabilities({ stdout: stream.stream, env: {} }),
        nativeName,
        stdout: stream.stream,
    })
    const rawLines = stream.value().split('\n')
    assert.equal(rawLines.at(-1), '')
    const lines = rawLines.slice(0, -1)
    assert.equal(lines.length, 4)
    for (const line of lines) assert.notEqual(line, '')
})

test('status success uses stdout and rich English output has only source semantics', () => {
    const stream = outputStream({ isTTY: true, columns: 100 })
    const stderr = outputStream()
    const directory = mkdtempSync(join(tmpdir(), 'modrex-i18n-status-success-'))
    try {
        writeFileSync(join(directory, 'en.json'), JSON.stringify({ key: 'English' }))
        writeFileSync(join(directory, 'de.json'), JSON.stringify({ key: 'Deutsch' }))
        const status = runI18nStatus({
            i18nDir: directory,
            stdout: stream.stream,
            stderr: stderr.stream,
            env: {},
        })
        assert.equal(status, 0)
        assert.equal(stderr.value(), '')
        const plainText = stripAnsi(stream.value())
        assert.match(plainText, /English \(en\).*Complete.*1 source/u)
        assert.match(stream.value(), /\[32m/u)
        assert.doesNotMatch(stream.value(), /Next:/u)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('current real status uses compact one-row semantics without recommendations', () => {
    const stream = outputStream({ isTTY: true, columns: 100 })
    const stderr = outputStream()
    assert.equal(runI18nStatus({ stdout: stream.stream, stderr: stderr.stream, env: {} }), 0)
    const text = stripAnsi(stream.value())
    assert.match(text, /English \(en\).*Complete.*424 source/u)
    assert.match(text, /Deutsch \(de\).*99\.5%.*420 accepted, 2 review, 2 missing/u)
    assert.match(text, /Русский \(ru\).*99\.5%.*420 accepted, 2 review, 2 missing/u)
    assert.match(text, /Українська \(uk\).*99\.5%.*422 accepted, 2 missing/u)
    assert.doesNotMatch(text, /Next:|0 missing|0 review/u)
    assert.equal(stderr.value(), '')
})

test('current real rich rows never exceed the declared terminal width', () => {
    for (const columns of [80, 90, 79]) {
        const stream = outputStream({ isTTY: true, columns })
        const stderr = outputStream()
        assert.equal(runI18nStatus({ stdout: stream.stream, stderr: stderr.stream, env: {} }), 0)
        const lines = stripAnsi(stream.value())
            .split('\n')
            .filter((line) => line.length > 0)
        assert.equal(lines.length, 4)
        for (const line of lines) {
            assert.ok(
                line.length <= columns,
                `line "${line}" (${line.length} cols) exceeds declared columns=${columns}`
            )
        }
    }
})

test('current real status suppresses the bar below the shared minimum width and renders it once width allows', () => {
    const narrow = outputStream({ isTTY: true, columns: 80 })
    assert.equal(
        runI18nStatus({ stdout: narrow.stream, stderr: outputStream().stream, env: {} }),
        0
    )
    const linesNarrow = stripAnsi(narrow.value())
        .split('\n')
        .filter((line) => line.length > 0)
    for (const line of linesNarrow) assert.equal((line.match(/━/gu) ?? []).length, 0)

    const wide = outputStream({ isTTY: true, columns: 120 })
    assert.equal(runI18nStatus({ stdout: wide.stream, stderr: outputStream().stream, env: {} }), 0)
    const linesWide = stripAnsi(wide.value())
        .split('\n')
        .filter((line) => line.length > 0)
    for (const line of linesWide) assert.equal((line.match(/━/gu) ?? []).length, 40)
})

test('bold styling applies only to the locale label, not the whole row', () => {
    for (const finalState of [
        { accepted: 8, pending: 1, missing: 0 },
        { accepted: 8, pending: 0, missing: 1 },
        { accepted: 7, pending: 1, missing: 1 },
    ]) {
        const stream = outputStream({ isTTY: true, columns: 90 })
        renderStatus({
            summaries: {
                source: { kind: 'source', locale: 'en', total: 10 },
                targets: [
                    {
                        kind: 'target',
                        locale: 'de',
                        total: finalState.accepted + finalState.pending + finalState.missing,
                        accepted: finalState.accepted,
                        pendingCompatible: finalState.pending,
                        pendingPlaceholderIncompatible: 0,
                        missing: finalState.missing,
                    },
                ],
            },
            capabilities: detectCliCapabilities({ stdout: stream.stream, env: {} }),
            stdout: stream.stream,
        })
        const output = stream.value()
        // Each label is individually bold and self-reset: "[1m<label>[0m"
        assert.match(output, /\[1men \(en\)\[0m/u)
        assert.match(output, /\[1mde \(de\)\[0m/u)
        // Status text and counts must never be wrapped in a semantic bar color.
        for (const line of output.split('\n').filter(Boolean)) {
            const afterBar = line.split('[0m').pop()
            assert.doesNotMatch(stripAnsi(afterBar), /^$/u)
            assert.doesNotMatch(afterBar, /\[3[123]m/u)
        }
    }
})

test('status bar allocation is presentation-only and never alters underlying semantics', () => {
    const summary = buildTargetStatusSummary(
        locale('de', { accepted: 420, pending: 2, missing: 0 }),
        422
    )
    const status = deriveTargetStatus(summary)
    for (const width of [32, 40]) {
        allocateStatusBar(
            {
                accepted: status.accepted,
                pending: status.pending,
                missing: status.missing,
                total: status.total,
            },
            width
        )
        assert.equal(status.accepted, 420)
        assert.equal(status.pending, 2)
        assert.equal(status.missing, 0)
        assert.equal(status.label, '100%')
        assert.equal(status.translatedPercentage, '100%')
    }
})

test('plain status output is deterministic and omits zero counts and actions', () => {
    const summaries = {
        source: { kind: 'source', locale: 'en', total: 2 },
        targets: [
            {
                kind: 'target',
                locale: 'de',
                total: 2,
                accepted: 0,
                pendingCompatible: 1,
                pendingPlaceholderIncompatible: 0,
                missing: 1,
            },
        ],
    }
    const outputs = []
    for (let index = 0; index < 2; index += 1) {
        const stream = outputStream()
        renderStatus({
            summaries,
            capabilities: detectCliCapabilities({ stdout: stream.stream, env: {} }),
            stdout: stream.stream,
        })
        outputs.push(stream.value())
    }
    assert.equal(outputs[0], outputs[1])
    assert.match(outputs[0], /en \(en\)/u)
    assert.match(outputs[0], /de \(de\): 50%; 1 review, 1 missing/u)
    assert.doesNotMatch(outputs[0], /Next:|pnpm i18n:(?:translate|review)/u)
    assert.doesNotMatch(outputs[0], /\[/u)
})
