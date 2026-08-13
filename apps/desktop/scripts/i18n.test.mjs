import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { formatMissingReport, inspectLocales, runCheckI18n, runI18nCli } from './check-i18n.mjs'
import {
    buildTranslationTable,
    expectedReadme,
    readTranslationContributors,
    replaceTranslationTable,
    runReadmeCommand,
} from './update-i18n-readme.mjs'
import { collectTranslationContributors, localeJsonChanged } from './update-i18n-contributors.mjs'

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

test('marked English values remain missing without placeholder or plural errors', () => {
    withLocales(
        {
            'en.json': {
                launch: { game: 'Launch {game}' },
                mods: { count: '{count} mods', countSingle: '{count} mod' },
            },
            'de.json': {
                launch: { game: '! Old English text' },
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

test('inspectLocales rejects invalid values, changed placeholders, and incomplete pairs', () => {
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
            assert.match(errors, /'common\.count' and 'common\.countSingle' together/)
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
                assert.equal(status, 1)
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
            assert.match(stdout.value(), /English \(en\)\s+100%/)
            assert.match(stdout.value(), /Deutsch \(de\)\s+50%/)
            assert.match(stdout.value(), /Русский \(ru\)\s+100%/)
        }
    )
})

test('locale command reports actionable placeholder and plural-pair errors', () => {
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
            assert.match(stderr.value(), /^de\.json\n2 validation problems/)
            assert.match(stderr.value(), /launch\.game:\n  placeholder mismatch/)
            assert.match(stderr.value(), /English: "Launch \{game\}"/)
            assert.match(stderr.value(), /Deutsch: "Spiel starten"/)
            assert.match(stderr.value(), /Missing placeholder: \{game\}/)
            assert.match(stderr.value(), /mods\.count \/ mods\.countSingle:/)
            assert.match(stderr.value(), /Translate both keys together\./)
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
    assert.match(stdout.value(), /pnpm i18n:check <locale>/)
    assert.match(stdout.value(), /pnpm i18n:fill <locale>/)
    assert.match(stdout.value(), /pnpm i18n:translate <locale>/)
    assert.doesNotMatch(stdout.value(), /node apps\/desktop\/scripts/)
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
            assert.match(stdout.value(), /2 marked English fallbacks/)
            assert.match(stdout.value(), /Coverage remains 33\.3%/)
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
            for (const [args, expected] of [
                [['--translate', 'uk'], /Locale 'uk' does not exist.*i18n:create uk/s],
                [['--create', 'de'], /Locale 'de' already exists.*i18n:fill de/s],
                [['--create', 'pt-br'], /must use canonical casing 'pt-BR\.json'/],
            ]) {
                const stderr = captureStream()
                const status = await runI18nCli(args, {
                    i18nDir: directory,
                    stderr: stderr.stream,
                })
                assert.equal(status, 1)
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
                second: { three: 'Three' },
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
                        second: { three: '! Three' },
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
            ])
            assert.match(stdout.value(), /Created .*uk\.json with 3 marked English fallbacks/)
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
    const inspection = {
        sourceLocale: 'en',
        totalCount: 3,
        locales: [
            { id: 'de', translatedCount: 2, totalCount: 3 },
            { id: 'ru', translatedCount: 3, totalCount: 3 },
        ],
    }
    const contributors = {
        de: ['TarekLP', 'AnotherTranslator'],
        ru: ['ShulhaOleh'],
    }
    const table = buildTranslationTable(inspection, contributors)
    assert.equal(
        table,
        [
            '| Language | Coverage | Contributors |',
            '| --- | ---: | --- |',
            '| English (en) | 100% | - |',
            '| Deutsch (de) | 66.7% | [AnotherTranslator](https://github.com/AnotherTranslator), [TarekLP](https://github.com/TarekLP) |',
            '| Русский (ru) | 100% | [ShulhaOleh](https://github.com/ShulhaOleh) |',
        ].join('\n')
    )
    assert.doesNotMatch(table, /\(\d+\/\d+\)/)
    assert.equal(buildTranslationTable(inspection, contributors), table)
    assert.throws(
        () => buildTranslationTable(inspection, { fr: ['Translator'] }),
        /unknown locale 'fr'/
    )

    const readme = [
        '# Project',
        '<!-- TRANSLATION_STATUS_START -->',
        'old',
        '<!-- TRANSLATION_STATUS_END -->',
    ].join('\n')
    assert.match(
        replaceTranslationTable(readme, table),
        /<!-- prettier-ignore -->\n\| Language \| Coverage \| Contributors \|/
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
    assert.equal(localeJsonChanged('{"common":{"open":"Öffnen"}}', '{"common":{}}', 'de'), true)
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
