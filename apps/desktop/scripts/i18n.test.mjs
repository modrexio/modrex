import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { formatMissingReport, inspectLocales, runCheckI18n } from './check-i18n.mjs'
import {
    buildTranslationTable,
    expectedReadme,
    replaceTranslationTable,
    runReadmeCommand,
} from './update-i18n-readme.mjs'

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

test('missing command rejects an unknown locale clearly', () => {
    withLocales(
        {
            'en.json': { common: { install: 'Install' } },
            'de.json': {},
        },
        (directory) => {
            const stdout = captureStream()
            const stderr = captureStream()
            const status = runCheckI18n(['--missing', 'xx'], {
                i18nDir: directory,
                stdout: stdout.stream,
                stderr: stderr.stream,
            })
            assert.equal(status, 1)
            assert.equal(stdout.value(), '')
            assert.match(stderr.value(), /Unknown translation locale 'xx'.*Available locales: de/)
        }
    )
})

test('translation table contains deterministic coverage without contributor attribution', () => {
    const inspection = {
        sourceLocale: 'en',
        totalCount: 2,
        locales: [{ id: 'de', translatedCount: 1, totalCount: 2 }],
    }
    const table = buildTranslationTable(inspection)
    assert.match(table, /^\| Language \| Key coverage \|/)
    assert.match(table, /Deutsch \(de\) \| 50% \(1\/2\) \|/)
    assert.doesNotMatch(table, /contributor|Gordon|github\.com/i)

    const readme = [
        '# Project',
        '<!-- TRANSLATION_STATUS_START -->',
        'old',
        '<!-- TRANSLATION_STATUS_END -->',
    ].join('\n')
    assert.match(
        replaceTranslationTable(readme, table),
        /<!-- prettier-ignore -->\n\| Language \| Key coverage \|/
    )
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
