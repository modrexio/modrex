import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { formatMissingReport, inspectLocales, runCheckI18n, runI18nCli } from './check-i18n.mjs'
import { formatSyncSummary, SYNC_OPERATION } from './i18n-sync.mjs'
import { reviewLocaleSession } from './i18n-review.mjs'
import { createSemanticStyles, renderPlaceholderText } from './i18n-presentation-cli.mjs'

function stream() {
    let value = ''
    return { stream: { write: (chunk) => (value += chunk) }, value: () => value }
}

function withLocales(files, callback) {
    const directory = mkdtempSync(join(tmpdir(), 'modrex-i18n-step4-'))
    const cleanup = () => rmSync(directory, { recursive: true, force: true })
    try {
        for (const [name, value] of Object.entries(files)) {
            writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + '\n')
        }
        const result = callback(directory)
        if (result && typeof result.then === 'function') return result.finally(cleanup)
        cleanup()
        return result
    } catch (error) {
        cleanup()
        throw error
    }
}

test('help leads with workflow grammar and grouped public commands', () => {
    const stdout = stream()
    const stderr = stream()
    assert.equal(runCheckI18n(['--help'], { stdout: stdout.stream, stderr: stderr.stream }), 0)
    const output = stdout.value()
    assert.match(
        output,
        /^Modrex translation CLI\n\n!  translate this\n\?  review this\nno prefix  accepted translation/u
    )
    assert.match(output, /Inspect[\s\S]*pnpm i18n:status[\s\S]*pnpm i18n:missing/u)
    assert.match(output, /Prepare[\s\S]*pnpm i18n:fill[\s\S]*pnpm i18n:sync/u)
    assert.match(output, /Translate[\s\S]*pnpm i18n:translate[\s\S]*pnpm i18n:review/u)
    assert.doesNotMatch(output, /node scripts\//u)
    assert.equal(stderr.value(), '')
})

test('missing report is numbered and offers only a conditional translate action', () => {
    withLocales(
        {
            'en.json': { first: 'First', second: 'Second' },
            'de.json': { first: '! First', second: 'Zweite' },
        },
        (directory) => {
            const inspection = inspectLocales(directory)
            const report = formatMissingReport(inspection, 'de')
            assert.match(report, /1 missing key/u)
            assert.match(report, /1\. first\n  English: "First"/u)
            assert.match(report, /Next: pnpm i18n:translate de/u)
        }
    )
    withLocales(
        { 'en.json': { first: 'First', second: 'Second' }, 'de.json': { second: 'Zweite' } },
        (directory) => {
            const report = formatMissingReport(inspectLocales(directory), 'de')
            assert.match(report, /1\. first\n  English: "First"/u)
            assert.match(report, /Next: pnpm i18n:translate de/u)
        }
    )
    withLocales({ 'en.json': { first: 'First' }, 'de.json': { first: 'Erste' } }, (directory) => {
        const report = formatMissingReport(inspectLocales(directory), 'de')
        assert.match(report, /0 missing keys/u)
        assert.doesNotMatch(report, /Next: pnpm i18n:translate/u)
    })
})

test('fill and create summaries preserve target text and use a translation action only for remaining work', async () => {
    await withLocales(
        { 'en.json': { first: 'First', second: 'Second' }, 'de.json': { first: 'Erste' } },
        async (directory) => {
            const stdout = stream()
            const status = await runI18nCli(['--fill', 'de'], {
                i18nDir: directory,
                stdout: stdout.stream,
                ask: async () => assert.fail('fill must not prompt'),
            })
            assert.equal(status, 0)
            assert.match(stdout.value(), /Scaffolds added: 1/u)
            assert.match(stdout.value(), /Target-language text preserved\./u)
            assert.match(stdout.value(), /Next: pnpm i18n:translate de/u)
            assert.equal(JSON.parse(readFileSync(join(directory, 'de.json'))).first, 'Erste')
        }
    )
    await withLocales({ 'en.json': { first: 'First' } }, async (directory) => {
        const stdout = stream()
        const status = await runI18nCli(['--create', 'de'], {
            i18nDir: directory,
            stdout: stdout.stream,
            ask: async () => assert.fail('create must not prompt'),
        })
        assert.equal(status, 0)
        assert.match(stdout.value(), /Created .*de\.json/u)
        assert.match(stdout.value(), /Scaffolds added: 1/u)
        assert.match(stdout.value(), /Coverage remains 0%/u)
        assert.match(stdout.value(), /Next: pnpm i18n:translate de/u)
        assert.doesNotMatch(stdout.value(), /translation(s)? created/u)
    })
})

test('sync summary names workflow maintenance and zero target-content edits', () => {
    const output = formatSyncSummary({
        writes: [
            {
                id: 'de',
                changed: true,
                operations: [
                    { kind: SYNC_OPERATION.SCAFFOLD_ADDED },
                    { kind: SYNC_OPERATION.REVIEW_REQUESTED },
                ],
            },
        ],
        written: ['de'],
    })
    assert.match(output, /scaffolds added/u)
    assert.match(output, /review requests added/u)
    assert.match(output, /Target-language content edits: 0/u)
    assert.match(output, /No target-language text was created, rewritten, or accepted/u)
    assert.match(output, /Inspect and stage/u)
})

test('translate and review sessions expose paths, counters, and completion counts', async () => {
    await withLocales({ 'en.json': { first: 'First' }, 'de.json': {} }, async (directory) => {
        const stdout = stream()
        const status = await runI18nCli(['--translate', 'de'], {
            i18nDir: directory,
            stdout: stdout.stream,
            ask: async () => 'Erste',
        })
        assert.equal(status, 0)
        assert.match(stdout.value(), /Path: .*de\.json/u)
        assert.match(stdout.value(), /Marker reminder/u)
        assert.match(stdout.value(), /\[1\/1\] first/u)
        assert.match(stdout.value(), /Saved: 1/u)
        assert.match(stdout.value(), /Skipped: 0/u)
        assert.match(stdout.value(), /Remaining: 0/u)
    })

    const stdout = stream()
    const result = await reviewLocaleSession({
        review: {
            locale: { id: 'de', bundle: { key: '? X' } },
            localePath: 'apps/desktop/src/renderer/src/i18n/de.json',
            candidates: [
                {
                    key: 'key',
                    lastAcceptedSourceText: 'A',
                    currentSourceText: 'B',
                    currentTargetText: 'X',
                    placeholderCompatible: true,
                },
            ],
        },
        ask: async () => 's',
        stdout: stdout.stream,
        write: () => {},
    })
    assert.deepEqual(result, { edited: 0, kept: 0, skipped: 1 })
    assert.match(stdout.value(), /Path: .*de\.json/u)
    assert.match(stdout.value(), /\[1\/1\] key/u)
    assert.match(stdout.value(), /English at last accepted checkpoint/u)
    assert.match(stdout.value(), /Current English/u)
    assert.match(stdout.value(), /Current target/u)
    assert.match(stdout.value(), /Review complete: 0 edited, 0 kept\./u)
    assert.match(stdout.value(), /Saved: 0\nSkipped: 1\nRemaining: 0/u)
})

function reviewCandidate(key, target = 'X', compatible = true) {
    return {
        key,
        lastAcceptedSourceText: 'Accepted {name}',
        currentSourceText: 'Current {name}',
        currentTargetText: target,
        placeholderCompatible: compatible,
    }
}

function reviewFixture(candidates) {
    return {
        locale: {
            id: 'de',
            bundle: Object.fromEntries(
                candidates.map((candidate) => [candidate.key, `? ${candidate.currentTargetText}`])
            ),
        },
        localePath: join(tmpdir(), 'modrex-step4-review.json'),
        candidates,
    }
}

test('review reports saved, skipped, and remaining for mixed decisions', async () => {
    const candidates = [reviewCandidate('edit'), reviewCandidate('keep'), reviewCandidate('skip')]
    const stdout = stream()
    const writes = []
    const answers = ['e', 'Bear {name}', 'k', 's']
    const result = await reviewLocaleSession({
        review: reviewFixture(candidates),
        ask: async () => answers.shift(),
        stdout: stdout.stream,
        write: (_path, bundle) => writes.push(bundle),
    })
    assert.deepEqual(result, { edited: 1, kept: 1, skipped: 1 })
    assert.equal(writes.length, 2)
    assert.match(stdout.value(), /Saved: 2\nSkipped: 1\nRemaining: 0/u)
})

test('review interruption preserves prior decisions and reports remaining work', async () => {
    const candidates = [
        reviewCandidate('edit'),
        reviewCandidate('skip'),
        reviewCandidate('later-one'),
        reviewCandidate('later-two'),
    ]
    const stdout = stream()
    const writes = []
    let answer = 0
    await assert.rejects(
        reviewLocaleSession({
            review: reviewFixture(candidates),
            ask: async () => {
                answer += 1
                if (answer === 1) return 'e'
                if (answer === 2) return 'Bear {name}'
                if (answer === 3) return 's'
                throw new Error('interrupted')
            },
            stdout: stdout.stream,
            write: (_path, bundle) => writes.push(bundle),
        }),
        /interrupted/u
    )
    assert.equal(writes.length, 1)
    assert.equal(writes[0].edit, 'Bear {name}')
    assert.match(stdout.value(), /Review interrupted[\s\S]*Saved: 1\nSkipped: 1\nRemaining: 2/u)
})

test('incompatible Keep remains unavailable and is not saved', async () => {
    const candidate = reviewCandidate('bad', 'No {other}', false)
    const stdout = stream()
    const answers = ['k', 's']
    const result = await reviewLocaleSession({
        review: reviewFixture([candidate]),
        ask: async () => answers.shift(),
        stdout: stdout.stream,
        write: () => assert.fail('incompatible Keep must not write'),
    })
    assert.deepEqual(result, { edited: 0, kept: 0, skipped: 1 })
    assert.match(stdout.value(), /Keep unavailable/u)
    assert.match(stdout.value(), /Saved: 0\nSkipped: 1\nRemaining: 0/u)
})

test('shared placeholder rendering preserves raw text and highlights every occurrence', () => {
    const raw = 'Move {item} from {source} to {target}: {item}'
    const plain = renderPlaceholderText(raw)
    const rich = renderPlaceholderText(raw, createSemanticStyles(true))
    assert.equal(plain, raw)
    assert.equal((rich.match(/\u001b\[36m\{/gu) ?? []).length, 4)
    assert.match(rich, /Move /u)
    assert.match(rich, / to /u)
})

test('missing reports highlight placeholders only in rich mode', () => {
    withLocales(
        { 'en.json': { launch: 'Launch {game} for {name} vs {name}' }, 'de.json': {} },
        (directory) => {
            const inspection = inspectLocales(directory)
            const plain = formatMissingReport(inspection, 'de')
            const rich = formatMissingReport(inspection, 'de', createSemanticStyles(true))
            assert.match(plain, /Launch \{game\} for \{name\} vs \{name\}/u)
            assert.doesNotMatch(plain, /\u001b\[/u)
            assert.equal((rich.match(/\u001b\[36m\{/gu) ?? []).length, 3)
            assert.match(rich, /Next: pnpm i18n:translate de/u)
        }
    )
})

test('review and translate rich displays highlight foundation placeholders', async () => {
    const reviewOutput = stream()
    reviewOutput.stream.isTTY = true
    const reviewAnswers = ['s']
    await reviewLocaleSession({
        review: { ...reviewFixture([reviewCandidate('key')]), localePath: 'de.json' },
        ask: async () => reviewAnswers.shift(),
        stdout: reviewOutput.stream,
        env: { TERM: 'xterm' },
        write: () => {},
    })
    assert.match(reviewOutput.value(), /\u001b\[36m\{name\}/u)

    await withLocales({ 'en.json': { key: 'Launch {name}' }, 'de.json': {} }, async (directory) => {
        const translateOutput = stream()
        translateOutput.stream.isTTY = true
        await runI18nCli(['--translate', 'de'], {
            i18nDir: directory,
            stdout: translateOutput.stream,
            env: { TERM: 'xterm' },
            ask: async () => '',
        })
        assert.match(translateOutput.value(), /\u001b\[36m\{name\}/u)
    })
})

test('check pending fallback stays successful on stdout and blocking errors stay on stderr', () => {
    withLocales(
        { 'en.json': { message: 'Hello {name}' }, 'de.json': { message: '? Hallo' } },
        (directory) => {
            const stdout = stream()
            const stderr = stream()
            const status = runCheckI18n(['--locale', 'de'], {
                i18nDir: directory,
                stdout: stdout.stream,
                stderr: stderr.stream,
            })
            assert.equal(status, 0)
            assert.equal(stderr.value(), '')
            assert.match(stdout.value(), /runtime uses English/u)
            assert.match(stdout.value(), /Next: pnpm i18n:review de/u)
        }
    )
    withLocales(
        { 'en.json': { message: 'Hello {name}' }, 'de.json': { message: 'Hallo' } },
        (directory) => {
            const stdout = stream()
            const stderr = stream()
            const status = runCheckI18n(['--locale', 'de'], {
                i18nDir: directory,
                stdout: stdout.stream,
                stderr: stderr.stream,
            })
            assert.equal(status, 1)
            assert.equal(stdout.value(), '')
            assert.match(stderr.value(), /placeholder mismatch/u)
        }
    )
    withLocales(
        { 'en.json': { message: 'Open…' }, 'de.json': { message: 'Öffnen\u200b' } },
        (directory) => {
            const stdout = stream()
            const stderr = stream()
            assert.equal(
                runCheckI18n([], {
                    i18nDir: directory,
                    stdout: stdout.stream,
                    stderr: stderr.stream,
                }),
                0
            )
            assert.match(stdout.value(), /warning/u)
            assert.equal(stderr.value(), '')
        }
    )
})

test('sync summaries cover every maintenance category without target edits', () => {
    const operations = Object.values(SYNC_OPERATION).map((kind) => ({ kind }))
    const output = formatSyncSummary({
        writes: [{ id: 'de', changed: true, operations }],
        written: ['de'],
    })
    assert.match(output, /1 scaffolds added/u)
    assert.match(output, /1 refreshed/u)
    assert.match(output, /1 removed/u)
    assert.match(output, /1 review requests added/u)
    assert.match(output, /1 source-return markers cleared/u)
    assert.match(output, /Target-language content edits: 0/u)
})

test('fill reports added, refreshed, removed, mixed, and no-op operations', async () => {
    await withLocales(
        { 'en.json': { first: 'Current', second: 'Second' }, 'de.json': { first: '! Old' } },
        async (directory) => {
            const stdout = stream()
            const status = await runI18nCli(['--fill', 'de'], {
                i18nDir: directory,
                stdout: stdout.stream,
            })
            assert.equal(status, 0)
            assert.match(stdout.value(), /Scaffolds added: 1/u)
            assert.match(stdout.value(), /Scaffolds refreshed: 1/u)
            assert.match(stdout.value(), /Obsolete scaffolds removed: 0/u)
        }
    )
    await withLocales(
        { 'en.json': { first: 'Current' }, 'de.json': { first: '! Current', old: '! Old' } },
        async (directory) => {
            const stdout = stream()
            const status = await runI18nCli(['--fill', 'de'], {
                i18nDir: directory,
                stdout: stdout.stream,
            })
            assert.equal(status, 0)
            assert.match(stdout.value(), /Obsolete scaffolds removed: 1/u)
            assert.doesNotMatch(stdout.value(), /translation(s)? (created|rewritten|accepted)/u)
        }
    )
    await withLocales(
        {
            'en.json': { first: 'Current', second: 'Second' },
            'de.json': { first: '! Old', old: '! Old' },
        },
        async (directory) => {
            const stdout = stream()
            const status = await runI18nCli(['--fill', 'de'], {
                i18nDir: directory,
                stdout: stdout.stream,
            })
            assert.equal(status, 0)
            assert.match(stdout.value(), /Scaffolds added: 1/u)
            assert.match(stdout.value(), /Scaffolds refreshed: 1/u)
            assert.match(stdout.value(), /Obsolete scaffolds removed: 1/u)
        }
    )
    await withLocales(
        { 'en.json': { first: 'Current' }, 'de.json': { first: 'Erste' } },
        async (directory) => {
            await runI18nCli(['--fill', 'de'], { i18nDir: directory, stdout: stream().stream })
            const stdout = stream()
            const status = await runI18nCli(['--fill', 'de'], {
                i18nDir: directory,
                stdout: stdout.stream,
            })
            assert.equal(status, 0)
            assert.match(stdout.value(), /already canonical/u)
            assert.doesNotMatch(stdout.value(), /Next:/u)
        }
    )
})

test('check remains history-independent and workflow output stays on stdout', () => {
    withLocales({ 'en.json': { first: 'First' }, 'de.json': { first: '? Erste' } }, (directory) => {
        const stdout = stream()
        const stderr = stream()
        assert.equal(
            runCheckI18n([], { i18nDir: directory, stdout: stdout.stream, stderr: stderr.stream }),
            0
        )
        assert.match(stdout.value(), /review/u)
        assert.equal(stderr.value(), '')
    })
})

test('Step 4 commands do not render the status aggregate bar', async () => {
    const stdout = stream()
    assert.equal(runCheckI18n(['--help'], { stdout: stdout.stream }), 0)
    assert.doesNotMatch(stdout.value(), /\[={24}\]/u)
    await withLocales({ 'en.json': { first: 'First' }, 'de.json': {} }, async (directory) => {
        const fill = stream()
        await runI18nCli(['--fill', 'de'], { i18nDir: directory, stdout: fill.stream })
        assert.doesNotMatch(fill.value(), /\[={24}\]/u)
    })
})
