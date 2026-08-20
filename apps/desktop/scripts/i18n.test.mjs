import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { formatMissingReport, inspectLocales, runCheckI18n, runI18nCli } from './check-i18n.mjs'
import {
    parseSourceValue,
    parseTargetValue,
    placeholderContract,
    TARGET_VALUE_KIND,
} from '../src/shared/i18n-values.js'
import {
    expectedReadme,
    renderTranslationStatusReadme,
    readTranslationContributors,
    replaceTranslationTable,
    runReadmeCommand,
} from './update-i18n-readme.mjs'
import { collectTranslationContributors, localeJsonChanged } from './update-i18n-contributors.mjs'

test('target values parse into accepted, scaffold, and pending states', () => {
    assert.deepEqual(parseTargetValue('Hallo'), {
        kind: TARGET_VALUE_KIND.ACCEPTED,
        targetText: 'Hallo',
        placeholderContract: [],
    })
    assert.deepEqual(parseTargetValue('! Hello'), {
        kind: TARGET_VALUE_KIND.UNTRANSLATED_SCAFFOLD,
        sourceText: 'Hello',
    })
    assert.deepEqual(parseTargetValue('? Hallo'), {
        kind: TARGET_VALUE_KIND.PENDING,
        targetText: 'Hallo',
        placeholderContract: [],
    })
})

test('target markers require the exact prefix and ASCII space', () => {
    for (const value of [
        '!Hello',
        '?Hallo',
        '?! text',
        '!? text',
        ' ? text',
        '!\tHello',
        '?\tHallo',
        '!\u00a0Hello',
        '?\u00a0Hallo',
    ]) {
        assert.equal(parseTargetValue(value).kind, TARGET_VALUE_KIND.ACCEPTED)
    }
})

test('target parsing preserves marker payload whitespace exactly', () => {
    assert.equal(parseTargetValue(' Hallo ').targetText, ' Hallo ')
    assert.equal(parseTargetValue('?  Hallo \n').targetText, ' Hallo \n')
    assert.equal(parseTargetValue('!  Hello ').sourceText, ' Hello ')
})

test('target parsing rejects empty and nested pending payloads', () => {
    assert.throws(() => parseTargetValue('! '), /scaffold payload must not be empty/)
    assert.throws(() => parseTargetValue('? '), /target payload must not be empty/)
    assert.throws(() => parseTargetValue('? ! text'), /must not begin with a workflow marker/)
    assert.throws(() => parseTargetValue('? ? text'), /must not begin with a workflow marker/)
})

test('scaffolds retain raw English that begins with a reserved prefix', () => {
    assert.deepEqual(parseTargetValue('! ? English question'), {
        kind: TARGET_VALUE_KIND.UNTRANSLATED_SCAFFOLD,
        sourceText: '? English question',
    })
})

test('absent target values have their own state', () => {
    assert.deepEqual(parseTargetValue(undefined), { kind: TARGET_VALUE_KIND.ABSENT })
    assert.equal(parseTargetValue('').kind, TARGET_VALUE_KIND.ACCEPTED)
})

test('source parsing does not apply target workflow markers', () => {
    assert.deepEqual(parseSourceValue('? English question'), {
        kind: 'source',
        sourceText: '? English question',
        placeholderContract: [],
    })
})

test('locale parsing preserves Unicode without normalization', () => {
    const decomposed = 'Cafe\u0301'
    assert.notEqual(decomposed, decomposed.normalize('NFC'))
    assert.equal(parseSourceValue(decomposed).sourceText, decomposed)
    assert.equal(parseTargetValue(`? ${decomposed}`).targetText, decomposed)
})

test('placeholder contracts retain duplicate names', () => {
    assert.deepEqual(placeholderContract('{name} / {count} / {name}'), ['count', 'name', 'name'])
})

function withLocales(files, callback) {
    const directory = mkdtempSync(join(tmpdir(), 'modrex-i18n-'))
    try {
        for (const [name, value] of Object.entries(files)) {
            writeFileSync(join(directory, name), `${JSON.stringify(value, null, 4)}\n`)
        }
        callback(directory)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
}

async function withLocalesAsync(files, callback) {
    const directory = mkdtempSync(join(tmpdir(), 'modrex-i18n-'))
    try {
        for (const [name, value] of Object.entries(files)) {
            writeFileSync(join(directory, name), `${JSON.stringify(value, null, 4)}\n`)
        }
        await callback(directory)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
}

function promptAnswers(...answers) {
    let index = 0
    return async () => {
        assert.ok(index < answers.length, 'interactive session requested an unexpected answer')
        const answer = answers[index]
        index += 1
        if (answer instanceof Error) throw answer
        return answer
    }
}

function captureStream() {
    let value = ''
    return {
        stream: {
            write(chunk) {
                value += chunk
            },
        },
        value: () => value,
    }
}

test('inspectLocales accepts partial translations and reports coverage', () => {
    withLocales(
        {
            'en.json': { common: { install: 'Install', by: 'by {name}' } },
            'de.json': { common: { install: 'Installieren' } },
        },
        (directory) => {
            const inspection = inspectLocales(directory)
            assert.deepEqual(inspection.errors, [])
            assert.equal(inspection.locales[0].translatedCount, 1)
            assert.deepEqual(inspection.locales[0].missingKeys, ['common.by'])
        }
    )
})

test('pending values are translated but not accepted', () => {
    withLocales(
        {
            'en.json': {
                common: {
                    compatible: 'Hello {name}',
                    incompatible: 'Delete {count} files',
                    missing: 'Missing',
                },
            },
            'de.json': {
                common: {
                    compatible: '? Hallo {name}',
                    incompatible: '? {name} löschen',
                    missing: '! Missing',
                },
            },
        },
        (directory) => {
            const locale = inspectLocales(directory).locales[0]
            assert.deepEqual(locale.errors, [])
            assert.equal(locale.acceptedCount, 0)
            assert.equal(locale.pendingCount, 2)
            assert.equal(locale.pendingPlaceholderIncompatibleCount, 1)
            assert.equal(locale.translatedCount, 2)
            assert.equal(locale.missingCount, 1)
            assert.equal(
                locale.acceptedCount + locale.pendingCount + locale.missingCount,
                locale.totalCount
            )
            assert.deepEqual(locale.pendingPlaceholderIncompatibleKeys, ['common.incompatible'])
            assert.equal(locale.reviewNotices[0].type, 'pending-placeholder')
        }
    )
})

test('100% translated status still exposes pending review and fallback', () => {
    withLocales(
        {
            'en.json': { common: { one: 'One', two: 'Two {count}' } },
            'de.json': { common: { one: '? Eins', two: '? Zwei {name}' } },
        },
        (directory) => {
            const stdout = captureStream()
            const status = runCheckI18n(['--status'], {
                i18nDir: directory,
                stdout: stdout.stream,
            })

            assert.equal(status, 0)
            assert.match(stdout.value(), /Deutsch \(de\): 100%; 2 review, fallback=1/)
            assert.doesNotMatch(stdout.value(), /uses English fallback/)
        }
    )
})

test('pending placeholder mismatch is nonblocking but accepted mismatch fails', () => {
    withLocales(
        {
            'en.json': { action: 'Delete {count} files' },
            'de.json': { action: '? {name} löschen' },
        },
        (directory) => {
            const stdout = captureStream()
            const pendingStatus = runCheckI18n(['--locale', 'de'], {
                i18nDir: directory,
                stdout: stdout.stream,
            })
            assert.equal(pendingStatus, 0)
            assert.match(stdout.value(), /runtime uses English/)

            writeFileSync(
                join(directory, 'de.json'),
                `${JSON.stringify({ action: '{name} löschen' }, null, 4)}\n`
            )
            const stderr = captureStream()
            const acceptedStatus = runCheckI18n(['--locale', 'de'], {
                i18nDir: directory,
                stderr: stderr.stream,
            })
            assert.equal(acceptedStatus, 1)
            assert.match(stderr.value(), /placeholder mismatch/)
        }
    )
})

test('partial singular and plural states are independently valid', () => {
    for (const locale of [
        { count: '{count} Mods', countSingle: '! {count} mod' },
        { count: '! {count} mods', countSingle: '{count} Mod' },
        { count: '? {count} Mods', countSingle: '{count} Mod' },
        { count: '{count} Mods' },
    ]) {
        withLocales(
            {
                'en.json': { count: '{count} mods', countSingle: '{count} mod' },
                'de.json': locale,
            },
            (directory) => assert.deepEqual(inspectLocales(directory).errors, [])
        )
    }
})

test('stale scaffolds and malformed pending markers are blocking', () => {
    withLocales(
        {
            'en.json': { stale: 'Current', malformed: 'Current target' },
            'de.json': { stale: '! Previous', malformed: '? ! nested' },
        },
        (directory) => {
            const errors = inspectLocales(directory).errors.join('\n')
            assert.match(errors, /stale untranslated scaffold/)
            assert.match(errors, /invalid workflow marker syntax/)
        }
    )
})

test('current-file validation rejects whitespace-only marker payloads', () => {
    withLocales(
        {
            'en.json': { pending: 'Pending source', scaffold: 'Scaffold source' },
            'de.json': { pending: '?   ', scaffold: '!   ' },
        },
        (directory) => {
            const inspection = inspectLocales(directory)
            assert.equal(
                inspection.locales[0].issues.filter(({ type }) => type === 'empty-marker').length,
                2
            )
            assert.match(inspection.errors.join('\n'), /empty workflow marker payload/)
        }
    )
})

test('a scaffold may contain raw English beginning with a reserved prefix', () => {
    withLocales(
        {
            'en.json': { question: '? English question', exclamation: '! English exclamation' },
            'de.json': {
                question: '! ? English question',
                exclamation: '! ! English exclamation',
            },
        },
        (directory) => assert.deepEqual(inspectLocales(directory).errors, [])
    )
})

test('Unicode diagnostics distinguish errors, warnings, and English-only style', () => {
    withLocales(
        {
            'en.json': {
                warning: 'Cafe\u0301 …',
                hard: 'Unsafe\u0000source',
            },
            'de.json': {
                warning: 'Café\u200b',
                hard: 'Sicher',
            },
        },
        (directory) => {
            const inspection = inspectLocales(directory)
            assert.match(inspection.errors.join('\n'), /'en' key 'hard' contains U\+0000/)
            assert.ok(
                inspection.sourceWarnings.some(
                    ({ description }) => description === 'text is not NFC-normalized'
                )
            )
            assert.ok(
                inspection.sourceWarnings.some(({ description }) =>
                    description.includes("prefer '...'")
                )
            )
            assert.ok(
                inspection.locales[0].warnings.some(({ codePoint }) => codePoint === 'U+200B')
            )
        }
    )
})

test('Unicode and English style warnings keep check successful', () => {
    withLocales(
        {
            'en.json': { source: 'Open…' },
            'de.json': { source: 'Öffnen\u200b' },
        },
        (directory) => {
            const stdout = captureStream()
            const status = runCheckI18n([], { i18nDir: directory, stdout: stdout.stream })
            assert.equal(status, 0)
            assert.match(stdout.value(), /en: 1 warning/)
            assert.match(stdout.value(), /de:.*1 warning/s)
        }
    )
})

test('target Unicode hard errors fail current-file validation', () => {
    withLocales(
        {
            'en.json': { unsafe: 'Safe source' },
            'de.json': { unsafe: 'Unsicher\ufffd' },
        },
        (directory) => {
            const stderr = captureStream()
            const status = runCheckI18n(['--locale', 'de'], {
                i18nDir: directory,
                stderr: stderr.stream,
            })
            assert.equal(status, 1)
            assert.match(stderr.value(), /U\+FFFD \(replacement character\)/)
        }
    )
})

test('current scaffolds remain missing without placeholder or plural errors', () => {
    withLocales(
        {
            'en.json': {
                launch: { game: 'Launch {game}' },
                mods: { count: '{count} mods', countSingle: '{count} mod' },
            },
            'de.json': {
                launch: { game: '! Launch {game}' },
                mods: { count: '! {count} mods', countSingle: '! {count} mod' },
            },
        },
        (directory) => {
            const inspection = inspectLocales(directory)
            assert.deepEqual(inspection.errors, [])
            assert.equal(inspection.locales[0].translatedCount, 0)
            assert.deepEqual(inspection.locales[0].missingKeys, [
                'launch.game',
                'mods.count',
                'mods.countSingle',
            ])
        }
    )
})

test('inspectLocales rejects invalid values, unknown keys, and changed placeholders', () => {
    withLocales(
        {
            'en.json': {
                common: {
                    install: 'Install',
                    by: 'by {name}',
                    count: '{count} items',
                    countSingle: '{count} item',
                },
            },
            'de.json': {
                common: {
                    install: '',
                    by: 'von {user}',
                    count: '{count} Elemente',
                    extra: 'Extra',
                    invalid: 7,
                },
            },
        },
        (directory) => {
            const errors = inspectLocales(directory).errors.join('\n')
            assert.match(errors, /key 'common\.install' is empty/)
            assert.match(errors, /common\.extra/)
            assert.match(errors, /key 'common\.invalid' must be a string or object/)
            assert.match(
                errors,
                /key 'common\.by' has interpolation vars \[user\], expected \[name\]/
            )
            assert.doesNotMatch(errors, /translate.*together/i)
        }
    )
})

test('inspectLocales rejects non-canonical locale filenames', () => {
    withLocales(
        {
            'en.json': { common: { install: 'Install' } },
            'pt-br.json': { common: { install: 'Instalar' } },
        },
        (directory) => {
            assert.throws(
                () => inspectLocales(directory),
                /must use canonical casing 'pt-BR\.json'/
            )
        }
    )
})

test('missing report lists nested keys, English text, placeholders, and coverage', () => {
    withLocales(
        {
            'en.json': {
                common: { install: 'Install' },
                nested: { greeting: 'Hello {name}' },
            },
            'de.json': { common: { install: 'Installieren' } },
        },
        (directory) => {
            const report = formatMissingReport(inspectLocales(directory), 'de')
            assert.match(report, /^Deutsch \(de\): 1\/2 translated, 50%/)
            assert.match(report, /1 missing key/)
            assert.match(report, /nested\.greeting\n  English: "Hello \{name\}"/)
        }
    )
})

test('missing includes scaffolds and absence but excludes pending and accepted', () => {
    withLocales(
        {
            'en.json': {
                accepted: 'Accepted source',
                pending: 'Pending source',
                scaffold: 'Current scaffold source',
                absent: 'Current absent source',
            },
            'de.json': {
                accepted: 'Akzeptiert',
                pending: '? Ausstehend',
                scaffold: '! Current scaffold source',
            },
        },
        (directory) => {
            const inspection = inspectLocales(directory)
            assert.deepEqual(inspection.locales[0].missingKeys, ['scaffold', 'absent'])
            const report = formatMissingReport(inspection, 'de')
            assert.match(report, /scaffold\n  English: "Current scaffold source"/)
            assert.match(report, /absent\n  English: "Current absent source"/)
            assert.doesNotMatch(report, /accepted\n|pending\n/)
        }
    )
})

test('translator commands reject an unknown locale clearly', () => {
    withLocales(
        {
            'en.json': { common: { install: 'Install' } },
            'de.json': {},
        },
        (directory) => {
            for (const command of ['--missing', '--locale']) {
                const stdout = captureStream()
                const stderr = captureStream()
                const status = runCheckI18n([command, 'xx'], {
                    i18nDir: directory,
                    stdout: stdout.stream,
                    stderr: stderr.stream,
                })
                assert.equal(status, 2)
                assert.equal(stdout.value(), '')
                assert.match(
                    stderr.value(),
                    /Unknown translation locale 'xx'.*Available locales: de/
                )
            }
        }
    )
})

test('status command lists every locale with human-readable coverage', () => {
    withLocales(
        {
            'en.json': { common: { install: 'Install', open: 'Open' } },
            'de.json': { common: { install: 'Installieren' } },
            'ru.json': { common: { install: 'Установить', open: 'Открыть' } },
        },
        (directory) => {
            const stdout = captureStream()
            const status = runCheckI18n(['--status'], {
                i18nDir: directory,
                stdout: stdout.stream,
            })
            assert.equal(status, 0)
            assert.match(stdout.value(), /English \(en\): Complete; source=2/)
            assert.match(stdout.value(), /Deutsch \(de\): 50%; 1 accepted, 1 missing/)
            assert.match(stdout.value(), /Русский \(ru\): Complete; 2 accepted/)
        }
    )
})

test('locale command reports placeholder errors without rejecting partial pairs', () => {
    withLocales(
        {
            'en.json': {
                launch: { game: 'Launch {game}' },
                mods: { count: '{count} mods', countSingle: '{count} mod' },
            },
            'de.json': {
                launch: { game: 'Spiel starten' },
                mods: { count: '{count} Mods' },
            },
        },
        (directory) => {
            const stderr = captureStream()
            const status = runCheckI18n(['--locale', 'de'], {
                i18nDir: directory,
                stderr: stderr.stream,
            })
            assert.equal(status, 1)
            assert.match(stderr.value(), /^de\.json\n1 validation problem/)
            assert.match(stderr.value(), /launch\.game:\n  placeholder mismatch/)
            assert.match(stderr.value(), /English: "Launch \{game\}"/)
            assert.match(stderr.value(), /Deutsch: "Spiel starten"/)
            assert.match(stderr.value(), /Missing placeholder: \{game\}/)
            assert.doesNotMatch(stderr.value(), /singular\/plural pair/)
        }
    )
})

test('locale command accepts a valid partial translation', () => {
    withLocales(
        {
            'en.json': { common: { install: 'Install', open: 'Open' } },
            'de.json': { common: { install: 'Installieren' } },
        },
        (directory) => {
            const stdout = captureStream()
            const status = runCheckI18n(['--locale', 'de'], {
                i18nDir: directory,
                stdout: stdout.stream,
            })
            assert.equal(status, 0)
            assert.match(stdout.value(), /^de\.json\nValid/)
            assert.match(stdout.value(), /Coverage: 1\/2 translated \(50%\)/)
            assert.match(stdout.value(), /Missing: 1 key/)
        }
    )
})

test('locale command validates the English source directly', () => {
    withLocales(
        {
            'en.json': { source: 'Open…' },
            'de.json': { source: 'Öffnen' },
        },
        (directory) => {
            const stdout = captureStream()
            const status = runCheckI18n(['--locale', 'en'], {
                i18nDir: directory,
                stdout: stdout.stream,
            })
            assert.equal(status, 0)
            assert.match(stdout.value(), /^en\.json\nValid/)
            assert.match(stdout.value(), /horizontal ellipsis/)
            assert.match(stdout.value(), /Source strings: 1/)
        }
    )
})

test('positional locale shorthand validates one locale', async () => {
    await withLocalesAsync(
        {
            'en.json': { common: { install: 'Install', open: 'Open' } },
            'de.json': { common: { install: 'Installieren' } },
        },
        async (directory) => {
            const stdout = captureStream()
            const status = await runI18nCli(['de'], {
                i18nDir: directory,
                stdout: stdout.stream,
            })
            assert.equal(status, 0)
            assert.match(stdout.value(), /^de\.json\nValid/)
        }
    )
})

test('help presents the translator-facing pnpm commands', async () => {
    const stdout = captureStream()
    const status = await runI18nCli(['--help'], { stdout: stdout.stream })

    assert.equal(status, 0)
    assert.match(stdout.value(), /pnpm i18n:help/)
    assert.match(stdout.value(), /pnpm i18n:check \[locale\]/)
    assert.match(stdout.value(), /pnpm i18n:fill <locale>/)
    assert.match(stdout.value(), /pnpm i18n:translate <locale>/)
    assert.match(stdout.value(), /pnpm i18n:review <locale>/)
    assert.match(stdout.value(), /pnpm i18n:sync/)
    assert.doesNotMatch(stdout.value(), /node apps\/desktop\/scripts/)
})

test('invalid CLI usage exits 2', async () => {
    const stderr = captureStream()
    const status = await runI18nCli(['--missing'], { stderr: stderr.stream })
    assert.equal(status, 2)
    assert.match(stderr.value(), /Modrex translation CLI/)
})

test('fill updates the locale file in place for IDE translation', async () => {
    await withLocalesAsync(
        {
            'en.json': {
                first: { translated: 'Translated', missing: 'Missing {name}' },
                second: { stale: 'Current English' },
            },
            'de.json': {
                second: { stale: '! Previous English' },
                first: { translated: 'Übersetzt' },
            },
        },
        async (directory) => {
            const stdout = captureStream()
            const status = await runI18nCli(['--fill', 'de'], {
                i18nDir: directory,
                stdout: stdout.stream,
            })

            assert.equal(status, 0)
            assert.deepEqual(JSON.parse(readFileSync(join(directory, 'de.json'), 'utf8')), {
                first: {
                    translated: 'Übersetzt',
                    missing: '! Missing {name}',
                },
                second: { stale: '! Current English' },
            })
            const locale = inspectLocales(directory).locales[0]
            assert.equal(locale.translatedCount, 1)
            assert.deepEqual(locale.missingKeys, ['first.missing', 'second.stale'])
            assert.match(stdout.value(), /Scaffolds added: 1/)
            assert.match(stdout.value(), /Scaffolds refreshed: 1/)
            assert.match(stdout.value(), /Coverage remains 33\.3%/)
        }
    )
})

test('fill preserves accepted and pending text while repairing structure', async () => {
    await withLocalesAsync(
        {
            'en.json': {
                first: 'First',
                second: 'Second {count}',
                third: 'Third',
            },
            'de.json': {
                obsolete: '! Removed source',
                second: '? Zweite {name}  ',
                first: 'Erste',
            },
        },
        async (directory) => {
            const stdout = captureStream()
            const status = await runI18nCli(['--fill', 'de'], {
                i18nDir: directory,
                stdout: stdout.stream,
            })

            assert.equal(status, 0)
            assert.equal(
                readFileSync(join(directory, 'de.json'), 'utf8'),
                `${JSON.stringify(
                    {
                        first: 'Erste',
                        second: '? Zweite {name}  ',
                        third: '! Third',
                    },
                    null,
                    4
                )}\n`
            )
            assert.match(stdout.value(), /Scaffolds added: 1/)
            assert.match(stdout.value(), /Obsolete scaffolds removed: 1/)
            assert.match(stdout.value(), /Target-language text preserved\./)
        }
    )
})

test('fill refuses obsolete accepted or pending target content before writing', async () => {
    for (const obsolete of ['Alte Übersetzung', '? Alte Übersetzung']) {
        await withLocalesAsync(
            {
                'en.json': { current: 'Current', missing: 'Missing' },
                'de.json': { current: 'Aktuell', obsolete },
            },
            async (directory) => {
                const path = join(directory, 'de.json')
                const before = readFileSync(path, 'utf8')
                const stderr = captureStream()
                const status = await runI18nCli(['--fill', 'de'], {
                    i18nDir: directory,
                    stderr: stderr.stream,
                })

                assert.equal(status, 1)
                assert.equal(readFileSync(path, 'utf8'), before)
                assert.match(stderr.value(), /obsolete key contains target-language content/)
                assert.doesNotMatch(readFileSync(path, 'utf8'), /! Missing/)
            }
        )
    }
})

test('fill reports an already canonical locale without rewriting state', async () => {
    await withLocalesAsync(
        {
            'en.json': { translated: 'Translated', missing: 'Missing' },
            'de.json': { translated: 'Übersetzt', missing: '! Missing' },
        },
        async (directory) => {
            const path = join(directory, 'de.json')
            const before = readFileSync(path, 'utf8')
            const stdout = captureStream()
            const status = await runI18nCli(['--fill', 'de'], {
                i18nDir: directory,
                stdout: stdout.stream,
            })

            assert.equal(status, 0)
            assert.equal(readFileSync(path, 'utf8'), before)
            assert.match(stdout.value(), /is already canonical/)
        }
    )
})

test('fill rejects a nonexistent locale without creating a file', async () => {
    await withLocalesAsync(
        {
            'en.json': { common: { install: 'Install', open: 'Open' } },
        },
        async (directory) => {
            const stderr = captureStream()
            const status = await runI18nCli(['--fill', 'uk'], {
                i18nDir: directory,
                stdout: captureStream().stream,
                stderr: stderr.stream,
            })

            assert.equal(status, 1)
            assert.equal(existsSync(join(directory, 'uk.json')), false)
            assert.match(stderr.value(), /Locale 'uk' does not exist.*i18n:create uk/s)
        }
    )
})

test('translation commands distinguish existing, new, and invalid locales', async () => {
    await withLocalesAsync(
        {
            'en.json': { common: { install: 'Install' } },
            'de.json': {},
        },
        async (directory) => {
            for (const [args, expectedStatus, expected] of [
                [['--translate', 'uk'], 1, /Locale 'uk' does not exist.*i18n:create uk/s],
                [['--create', 'de'], 1, /Locale 'de' already exists.*i18n:fill de/s],
                [['--create', 'pt-br'], 2, /must use canonical casing 'pt-BR\.json'/],
            ]) {
                const stderr = captureStream()
                const status = await runI18nCli(args, {
                    i18nDir: directory,
                    stderr: stderr.stream,
                })
                assert.equal(status, expectedStatus)
                assert.match(stderr.value(), expected)
            }
        }
    )
})

test('create immediately scaffolds and discovers an IDE-ready locale', async () => {
    await withLocalesAsync(
        {
            'en.json': {
                first: { one: 'One', two: 'Two' },
                second: { three: 'Three', reserved: '? English source' },
            },
        },
        async (directory) => {
            const stdout = captureStream()
            const status = await runI18nCli(['--create', 'uk'], {
                ask: async () => assert.fail('create must not prompt'),
                i18nDir: directory,
                stdout: stdout.stream,
            })

            assert.equal(status, 0)
            assert.equal(
                readFileSync(join(directory, 'uk.json'), 'utf8'),
                `${JSON.stringify(
                    {
                        first: { one: '! One', two: '! Two' },
                        second: { three: '! Three', reserved: '! ? English source' },
                    },
                    null,
                    4
                )}\n`
            )

            const inspection = inspectLocales(directory)
            assert.deepEqual(inspection.errors, [])
            assert.deepEqual(
                inspection.locales.map((locale) => locale.id),
                ['uk']
            )
            assert.equal(inspection.locales[0].translatedCount, 0)
            assert.deepEqual(inspection.locales[0].missingKeys, [
                'first.one',
                'first.two',
                'second.three',
                'second.reserved',
            ])
            assert.match(stdout.value(), /Created .*uk\.json/)
            assert.match(stdout.value(), /Scaffolds added: 4/)
        }
    )
})

test('translate preserves existing values and restores English key order', async () => {
    await withLocalesAsync(
        {
            'en.json': { common: { first: 'First', second: 'Second', third: 'Third' } },
            'de.json': { common: { second: 'Zweite' } },
        },
        async (directory) => {
            const status = await runI18nCli(['--translate', 'de'], {
                ask: promptAnswers('Erste', 'Dritte'),
                i18nDir: directory,
                stdout: captureStream().stream,
            })

            assert.equal(status, 0)
            assert.deepEqual(JSON.parse(readFileSync(join(directory, 'de.json'), 'utf8')), {
                common: { first: 'Erste', second: 'Zweite', third: 'Dritte' },
            })
            assert.deepEqual(inspectLocales(directory).errors, [])
        }
    )
})

test('translate ignores pending entries and prompts only untranslated work', async () => {
    await withLocalesAsync(
        {
            'en.json': { pending: 'Current English', missing: 'Missing' },
            'de.json': { pending: '? Vorhanden' },
        },
        async (directory) => {
            const status = await runI18nCli(['--translate', 'de'], {
                ask: promptAnswers('Fehlend'),
                i18nDir: directory,
                stdout: captureStream().stream,
            })

            assert.equal(status, 0)
            assert.deepEqual(JSON.parse(readFileSync(join(directory, 'de.json'), 'utf8')), {
                pending: '? Vorhanden',
                missing: 'Fehlend',
            })
        }
    )
})

test('translate prompts one missing plural member with its counterpart for context', async () => {
    await withLocalesAsync(
        {
            'en.json': { count: '{count} mods', countSingle: '{count} mod' },
            'de.json': { count: '{count} Mods' },
        },
        async (directory) => {
            const stdout = captureStream()
            const status = await runI18nCli(['--translate', 'de'], {
                ask: promptAnswers('{count} Mod'),
                i18nDir: directory,
                stdout: stdout.stream,
            })

            assert.equal(status, 0)
            assert.match(stdout.value(), /Existing counterpart \(count\):\n  \{count\} Mods/)
            assert.deepEqual(JSON.parse(readFileSync(join(directory, 'de.json'), 'utf8')), {
                count: '{count} Mods',
                countSingle: '{count} Mod',
            })
        }
    )
})

test('translate retries placeholder mismatches before writing', async () => {
    await withLocalesAsync(
        {
            'en.json': { launch: { game: 'Launch {game}' } },
            'de.json': {},
        },
        async (directory) => {
            const stdout = captureStream()
            const status = await runI18nCli(['--translate', 'de'], {
                ask: promptAnswers('Spiel starten', 'Spiel {game} starten'),
                i18nDir: directory,
                stdout: stdout.stream,
            })

            assert.equal(status, 0)
            assert.match(stdout.value(), /Invalid translation:\n  Missing placeholder: \{game\}/)
            assert.deepEqual(JSON.parse(readFileSync(join(directory, 'de.json'), 'utf8')), {
                launch: { game: 'Spiel {game} starten' },
            })
        }
    )
})

test('translate does not turn entered workflow syntax into persisted state', async () => {
    await withLocalesAsync(
        {
            'en.json': { greeting: 'Hello' },
            'de.json': {},
        },
        async (directory) => {
            const stdout = captureStream()
            const status = await runI18nCli(['--translate', 'de'], {
                ask: promptAnswers('? Hallo', '! Hallo', 'Hallo'),
                i18nDir: directory,
                stdout: stdout.stream,
            })

            assert.equal(status, 0)
            assert.match(stdout.value(), /must not begin with the reserved/)
            assert.deepEqual(JSON.parse(readFileSync(join(directory, 'de.json'), 'utf8')), {
                greeting: 'Hallo',
            })
        }
    )
})

test('singular and plural translations are written atomically', async () => {
    await withLocalesAsync(
        {
            'en.json': {
                mods: { count: '{count} mods', countSingle: '{count} mod' },
            },
            'de.json': {},
        },
        async (directory) => {
            const skippedOutput = captureStream()
            const skippedStatus = await runI18nCli(['--translate', 'de'], {
                ask: promptAnswers('{count} Mod', '', '', ''),
                i18nDir: directory,
                stdout: skippedOutput.stream,
            })
            assert.equal(skippedStatus, 0)
            assert.deepEqual(JSON.parse(readFileSync(join(directory, 'de.json'), 'utf8')), {})
            assert.match(skippedOutput.value(), /must be completed together/)

            const savedStatus = await runI18nCli(['--translate', 'de'], {
                ask: promptAnswers('{count} Mod', '{count} Mods'),
                i18nDir: directory,
                stdout: captureStream().stream,
            })
            assert.equal(savedStatus, 0)
            assert.deepEqual(JSON.parse(readFileSync(join(directory, 'de.json'), 'utf8')), {
                mods: { count: '{count} Mods', countSingle: '{count} Mod' },
            })
            assert.deepEqual(inspectLocales(directory).errors, [])
        }
    )
})

test('an interrupted session leaves valid progress that translate can resume', async () => {
    await withLocalesAsync(
        {
            'en.json': { common: { first: 'First', second: 'Second' } },
            'de.json': {},
        },
        async (directory) => {
            const stderr = captureStream()
            const interruptedStatus = await runI18nCli(['--translate', 'de'], {
                ask: promptAnswers('Erste', new Error('interrupted')),
                i18nDir: directory,
                stdout: captureStream().stream,
                stderr: stderr.stream,
            })
            assert.equal(interruptedStatus, 1)
            assert.match(stderr.value(), /interrupted/)
            assert.deepEqual(JSON.parse(readFileSync(join(directory, 'de.json'), 'utf8')), {
                common: { first: 'Erste' },
            })
            assert.deepEqual(inspectLocales(directory).errors, [])

            const resumedStatus = await runI18nCli(['--translate', 'de'], {
                ask: promptAnswers('Zweite'),
                i18nDir: directory,
                stdout: captureStream().stream,
            })
            assert.equal(resumedStatus, 0)
            assert.deepEqual(
                formatMissingReport(inspectLocales(directory), 'de'),
                ['Deutsch (de): 2/2 translated, 100%', '0 missing keys'].join('\n')
            )
        }
    )
})

test('translate exits cleanly without prompting when a locale is complete', async () => {
    await withLocalesAsync(
        {
            'en.json': { common: { install: 'Install' } },
            'de.json': { common: { install: 'Installieren' } },
        },
        async (directory) => {
            const stdout = captureStream()
            const status = await runI18nCli(['--translate', 'de'], {
                ask: async () => assert.fail('complete locale should not prompt'),
                i18nDir: directory,
                stdout: stdout.stream,
            })
            assert.equal(status, 0)
            assert.match(stdout.value(), /No missing translations\.\nLocale is valid/)
        }
    )
})

test('translation table renders compact deterministic coverage and contributors', () => {
    const contributors = {
        de: ['TarekLP', 'AnotherTranslator'],
        ru: ['ShulhaOleh'],
    }
    const table = renderTranslationStatusReadme({
        summaries: {
            source: { kind: 'source', locale: 'en', total: 3 },
            targets: [
                {
                    kind: 'target',
                    locale: 'de',
                    total: 3,
                    accepted: 1,
                    pendingCompatible: 1,
                    pendingPlaceholderIncompatible: 0,
                    missing: 1,
                },
                {
                    kind: 'target',
                    locale: 'ru',
                    total: 3,
                    accepted: 3,
                    pendingCompatible: 0,
                    pendingPlaceholderIncompatible: 0,
                    missing: 0,
                },
            ],
        },
        names: { en: 'English', de: 'Deutsch', ru: 'Русский' },
        contributors,
    })
    assert.equal(
        table,
        [
            '| Language | Translation | Contributors |',
            '| --- | --- | --- |',
            '| [English (en)](apps/desktop/src/renderer/src/i18n/en.json) | <img src="assets/i18n/status/en.svg" alt="English source: 3 valid strings."> Complete | - |',
            '| [Deutsch (de)](apps/desktop/src/renderer/src/i18n/de.json) | <img src="assets/i18n/status/de.svg" alt="Deutsch (de): 1 accepted, 1 review, 1 missing; 66.7%."> 66.7% | [AnotherTranslator](https://github.com/AnotherTranslator), [TarekLP](https://github.com/TarekLP) |',
            '| [Русский (ru)](apps/desktop/src/renderer/src/i18n/ru.json) | <img src="assets/i18n/status/ru.svg" alt="Русский (ru): 3 accepted, 0 review, 0 missing; Complete."> Complete | [ShulhaOleh](https://github.com/ShulhaOleh) |',
            '',
            '<div class="i18n-status-legend"><img src="assets/i18n/status/legend/accepted.svg" alt=""> Accepted <img src="assets/i18n/status/legend/review.svg" alt=""> Review <img src="assets/i18n/status/legend/missing.svg" alt=""> Missing</div>',
            '',
            'To improve an existing language or add a new one, follow the',
            '[translation guide](TRANSLATING.md).',
        ].join('\n')
    )
    assert.doesNotMatch(table, /\(\d+\/\d+\)/)

    const readme = [
        '# Project',
        '<!-- TRANSLATION_STATUS_START -->',
        'old',
        '<!-- TRANSLATION_STATUS_END -->',
    ].join('\n')
    assert.match(
        replaceTranslationTable(readme, table),
        /<!-- prettier-ignore -->\n\| Language \| Translation \| Contributors \|/
    )
})

test('translation contributors come from linked GitHub commit authors', async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
        sha: `de-${index}`,
        parents: [{ sha: `parent-${index}` }],
        author: {
            login: index % 2 === 0 ? 'ZuluTranslator' : 'AlphaTranslator',
            type: 'User',
        },
    }))
    const requests = []
    const contributors = await collectTranslationContributors(
        ['de', 'ru'],
        (localeId, page) => {
            requests.push(`${localeId}:${page}`)
            if (localeId === 'de' && page === 1) return fullPage
            if (localeId === 'de') {
                return [
                    {
                        sha: 'translation',
                        parents: [{ sha: 'parent' }],
                        author: { login: 'TarekLP', type: 'User' },
                    },
                    {
                        sha: 'formatting',
                        parents: [{ sha: 'parent' }],
                        author: { login: 'ShulhaOleh', type: 'User' },
                    },
                    {
                        sha: 'merge',
                        parents: [{ sha: 'one' }, { sha: 'two' }],
                        author: { login: 'Merger', type: 'User' },
                    },
                    {
                        sha: 'bot',
                        parents: [{ sha: 'parent' }],
                        author: { login: 'translation-bot', type: 'Bot' },
                    },
                    { sha: 'unlinked', parents: [{ sha: 'parent' }], author: null },
                ]
            }
            return [
                {
                    sha: 'russian',
                    parents: [{ sha: 'parent' }],
                    author: { login: 'ShulhaOleh', type: 'User' },
                },
            ]
        },
        (_localeId, commit) => commit.sha !== 'formatting'
    )

    assert.deepEqual(contributors, {
        de: ['AlphaTranslator', 'TarekLP', 'ZuluTranslator'],
        ru: ['ShulhaOleh'],
    })
    assert.deepEqual(requests, ['de:1', 'de:2', 'ru:1'])
})

test('semantic locale comparison ignores formatting and key order', () => {
    const before = '{\n  "common": { "open": "Open", "close": "Close" }\n}\n'
    const reformatted = '{"common":{"close":"Close","open":"Open"}}'
    const translated = '{"common":{"close":"Schließen","open":"Open"}}'

    assert.equal(localeJsonChanged(before, reformatted, 'de'), false)
    assert.equal(localeJsonChanged(before, translated, 'de'), true)
    assert.equal(localeJsonChanged(undefined, translated, 'de'), true)
})

test('semantic locale comparison ignores generated English markers', () => {
    assert.equal(localeJsonChanged(undefined, '{"common":{"open":"! Open"}}', 'de'), false)
    assert.equal(
        localeJsonChanged(
            '{"common":{"open":"! Old English"}}',
            '{"common":{"open":"! Current English"}}',
            'de'
        ),
        false
    )
    assert.equal(
        localeJsonChanged('{"common":{"open":"! Open"}}', '{"common":{"open":"Öffnen"}}', 'de'),
        true
    )
})

test('semantic locale comparison counts additions, value changes, and deletions', () => {
    assert.equal(localeJsonChanged('{"common":{}}', '{"common":{"open":"Öffnen"}}', 'de'), true)
    assert.equal(
        localeJsonChanged('{"common":{"open":"Open"}}', '{"common":{"open":"Öffnen"}}', 'de'),
        true
    )
    assert.equal(localeJsonChanged('{"common":{"open":"Öffnen"}}', '{"common":{}}', 'de'), false)
})

test('temporary contributor API failures abort attribution generation', async () => {
    await assert.rejects(
        collectTranslationContributors(['de'], () => {
            throw new Error('GitHub unavailable')
        }),
        /GitHub unavailable/
    )
})

test('translation contributor metadata rejects duplicates and invalid GitHub usernames', () => {
    const directory = mkdtempSync(join(tmpdir(), 'modrex-i18n-contributors-'))
    const contributorsPath = join(directory, 'contributors.json')

    try {
        writeFileSync(contributorsPath, JSON.stringify({ de: ['TarekLP', 'TarekLP'] }))
        assert.throws(
            () => readTranslationContributors(contributorsPath),
            /contributors for 'de' contain duplicates/
        )

        writeFileSync(contributorsPath, JSON.stringify({ de: ['not a username'] }))
        assert.throws(
            () => readTranslationContributors(contributorsPath),
            /Invalid GitHub username for translation locale 'de'/
        )
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('--stdout prints the prospective README without modifying it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'modrex-readme-'))
    const readmePath = join(directory, 'README.md')
    const original = [
        '# Project',
        '<!-- TRANSLATION_STATUS_START -->',
        'stale',
        '<!-- TRANSLATION_STATUS_END -->',
    ].join('\n')
    writeFileSync(readmePath, original)

    try {
        const stdout = captureStream()
        const status = runReadmeCommand(['--stdout'], { readmePath, stdout: stdout.stream })
        assert.equal(status, 0)
        assert.equal(readFileSync(readmePath, 'utf8'), original)
        assert.equal(stdout.value(), expectedReadme(original))
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('--check detects stale and current README content without modifying it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'modrex-readme-'))
    const readmePath = join(directory, 'README.md')
    const stale = [
        '# Project',
        '<!-- TRANSLATION_STATUS_START -->',
        'stale',
        '<!-- TRANSLATION_STATUS_END -->',
    ].join('\n')
    writeFileSync(readmePath, stale)

    try {
        const staleError = captureStream()
        const staleStatus = runReadmeCommand(['--check'], {
            readmePath,
            stderr: staleError.stream,
        })
        assert.equal(staleStatus, 1)
        assert.match(staleError.value(), /README\.md is out of date/)
        assert.equal(readFileSync(readmePath, 'utf8'), stale)

        const current = expectedReadme(stale)
        writeFileSync(readmePath, current)
        const currentOutput = captureStream()
        const currentStatus = runReadmeCommand(['--check'], {
            readmePath,
            stdout: currentOutput.stream,
        })
        assert.equal(currentStatus, 0)
        assert.match(currentOutput.value(), /README\.md is current/)
        assert.equal(readFileSync(readmePath, 'utf8'), current)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})
