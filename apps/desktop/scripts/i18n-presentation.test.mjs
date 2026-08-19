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

test('capabilities distinguish rich, plain, color-disabled, and bar modes', () => {
    const tty = { isTTY: true, columns: 60 }
    assert.deepEqual(detectCliCapabilities({ stdout: tty, env: {} }), {
        ci: false,
        tty: true,
        dumb: false,
        color: true,
        rich: true,
        bar: true,
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
    assert.equal(detectCliCapabilities({ stdout: tty, env: { TERM: 'dumb' } }).bar, false)
    assert.equal(
        detectCliCapabilities({ stdout: { isTTY: true, columns: 59 }, env: {} }).bar,
        false
    )
    assert.equal(detectCliCapabilities({ stdout: {}, env: {} }).rich, false)
})

test('status bars use exact deterministic 24-cell allocation and state order', () => {
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
            24
        )
        assert.equal(renderStatusBar(summary).length, 26)
        for (const [index, count] of [counts.accepted, counts.pending, counts.missing].entries()) {
            if (count > 0) assert.ok(cells[index] > 0)
        }
    }
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
    assert.doesNotMatch(plain.value(), /\u001b\[/u)
    assert.doesNotMatch(plain.value(), /\[=+/u)
    assert.match(plain.value(), /accepted=420 review=2 fallback=1 missing=0 total=422/u)
    assert.match(plain.value(), /1 uses English fallback/u)

    const rich = outputStream({ isTTY: true, columns: 60 })
    renderStatus({
        summaries,
        capabilities: detectCliCapabilities({ stdout: rich.stream, env: {} }),
        nativeName: (id) => (id === 'en' ? 'English' : 'Deutsch'),
        stdout: rich.stream,
    })
    assert.match(rich.value(), /\u001b\[/u)
    const richText = rich.value().replace(/\u001b\[[0-9;]*m/gu, '')
    assert.match(richText, /\[=+\?+\]/u)
    assert.match(richText, /420 accepted · 2 review · 0 missing/u)
})

test('NO_COLOR retains an eligible bar while disabling ANSI', () => {
    const stream = outputStream({ isTTY: true, columns: 60 })
    renderStatus({
        summaries: {
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
        },
        capabilities: detectCliCapabilities({ stdout: stream.stream, env: { NO_COLOR: '' } }),
        stdout: stream.stream,
    })
    assert.doesNotMatch(stream.value(), /\u001b\[/u)
    assert.match(stream.value(), /\[={24}\]/u)
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
    for (const columns of [60]) {
        const stream = outputStream({ isTTY: true, columns })
        renderStatus({
            summaries: summary,
            capabilities: detectCliCapabilities({ stdout: stream.stream, env: {} }),
            stdout: stream.stream,
        })
        assert.match(stream.value(), /\[\u001b\[/u)
    }
    for (const columns of [59, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
        const stream = outputStream({ isTTY: true, columns })
        renderStatus({
            summaries: summary,
            capabilities: detectCliCapabilities({ stdout: stream.stream, env: {} }),
            stdout: stream.stream,
        })
        assert.doesNotMatch(stream.value(), /\[=+\?*!+\]/u)
        assert.match(stream.value(), /9 accepted · 0 review · 1 missing/u)
    }
})

test('color environment variables affect ANSI independently from rich bars', () => {
    const stdout = { isTTY: true, columns: 60 }
    for (const env of [
        { NO_COLOR: '' },
        { NO_COLOR: '1' },
        { NODE_DISABLE_COLORS: '1' },
        { NODE_DISABLE_COLORS: 'anything' },
    ]) {
        const capabilities = detectCliCapabilities({ stdout, env })
        assert.equal(capabilities.rich, true)
        assert.equal(capabilities.bar, true)
        assert.equal(capabilities.color, false)
    }
    assert.equal(detectCliCapabilities({ stdout, env: { NODE_DISABLE_COLORS: '0' } }).color, true)
})

test('largest-remainder ties use Accepted, Review, Missing order', () => {
    assert.deepEqual(
        allocateStatusBar({ accepted: 1, pending: 2, missing: 1, total: 4 }),
        [6, 12, 6]
    )
    assert.equal(
        renderStatusBar({ accepted: 1, pending: 2, missing: 1, total: 4 }),
        '[======????????????!!!!!!]'
    )
})

test('tiny nonzero Review and Missing states remain visible', () => {
    for (const counts of [
        { accepted: 421, pending: 1, missing: 0 },
        { accepted: 421, pending: 0, missing: 1 },
        { accepted: 420, pending: 1, missing: 1 },
    ]) {
        const summary = { ...counts, total: 422 }
        const bar = renderStatusBar(summary)
        const interior = bar.slice(1, -1)
        assert.equal(interior.length, 24)
        if (counts.pending > 0) assert.match(interior, /\?/u)
        if (counts.missing > 0) assert.match(interior, /!/u)
        if (counts.pending === 0) assert.doesNotMatch(interior, /\?/u)
        if (counts.missing === 0) assert.doesNotMatch(interior, /!/u)
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
                const interior = first.slice(1, -1)
                assert.equal(first, second)
                assert.equal(interior.length, 24)
                assert.match(interior, /^=*\?*!*$/u)
                for (const [count, character] of [
                    [accepted, '='],
                    [pending, '?'],
                    [missing, '!'],
                ]) {
                    const cells = interior.split(character).length - 1
                    assert.equal(cells > 0, count > 0)
                }
            }
        }
    }
})

test('fallback wording and stable plain fallback field are correct', () => {
    for (const [count, wording] of [
        [0, null],
        [1, '1 uses English fallback'],
        [2, '2 use English fallback'],
    ]) {
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
        assert.match(stream.value(), new RegExp(`fallback=${count}`))
        if (wording) assert.match(stream.value(), new RegExp(wording))
        else assert.doesNotMatch(stream.value(), /uses English fallback/u)
    }
})

test('next actions cover Missing, Review, both, complete, and fallback-only states', () => {
    const cases = [
        [
            { missing: 1, pendingCompatible: 0, pendingPlaceholderIncompatible: 0 },
            ['translate'],
            ['review'],
        ],
        [
            { missing: 0, pendingCompatible: 1, pendingPlaceholderIncompatible: 0 },
            ['review'],
            ['translate'],
        ],
        [
            { missing: 1, pendingCompatible: 1, pendingPlaceholderIncompatible: 0 },
            ['translate', 'review'],
            [],
        ],
        [
            { missing: 0, pendingCompatible: 0, pendingPlaceholderIncompatible: 0 },
            [],
            ['translate', 'review'],
        ],
        [
            { missing: 0, pendingCompatible: 0, pendingPlaceholderIncompatible: 1 },
            ['review'],
            ['translate'],
        ],
    ]
    for (const [counts, expected, absent] of cases) {
        const summary = {
            kind: 'target',
            locale: 'de',
            total: 2,
            accepted:
                2 -
                counts.missing -
                counts.pendingCompatible -
                counts.pendingPlaceholderIncompatible,
            ...counts,
        }
        const plain = outputStream()
        const rich = outputStream({ isTTY: true, columns: 60 })
        for (const output of [plain, rich]) {
            renderStatus({
                summaries: {
                    source: { kind: 'source', locale: 'en', total: 2 },
                    targets: [summary],
                },
                capabilities: detectCliCapabilities({ stdout: output.stream, env: {} }),
                stdout: output.stream,
            })
            for (const action of expected)
                assert.equal(output.value().split(`pnpm i18n:${action} de`).length - 1, 1)
            for (const action of absent)
                assert.equal(output.value().split(`pnpm i18n:${action} de`).length - 1, 0)
        }
    }
})

test('status success uses stdout and rich English output has only source semantics', () => {
    const stream = outputStream({ isTTY: true, columns: 60 })
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
        assert.match(stream.value(), /English \(en\) — Complete/u)
        assert.match(stream.value(), /Valid source: 1/u)
        assert.match(stream.value(), /\[=+\]/u)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('plain status output is deterministic and preserves action parity', () => {
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
    assert.match(outputs[0], /pnpm i18n:translate de/u)
    assert.match(outputs[0], /pnpm i18n:review de/u)
    assert.doesNotMatch(outputs[0], /\u001b\[/u)
})
