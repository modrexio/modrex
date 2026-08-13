import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { formatMissingReport, inspectLocales, runCheckI18n } from './check-i18n.mjs'
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
