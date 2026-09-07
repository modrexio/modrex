import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { serializeLocale } from './i18n-files.mjs'
import {
    checkChangedPaths,
    checkLocalePayloads,
    checkReadmeProse,
    checkWriterOutput,
    classifyWriterPath,
    runI18nWriterGuard,
} from './i18n-writer-guard.mjs'
import { snapshotFromBundles } from './i18n-history.mjs'
import { describeWorkingTree } from './i18n-tree-state.mjs'

const LOCALE_DIR = 'apps/desktop/src/renderer/src/i18n'
const README = (block) =>
    `# Modrex\n\nProse before.\n\n<!-- TRANSLATION_STATUS_START -->\n${block}\n<!-- TRANSLATION_STATUS_END -->\n\nProse after.\n`

function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function targets(localeId, bundle) {
    return snapshotFromBundles('fixture', { [localeId]: bundle }).locales.get(localeId).targets
}

function createRepo() {
    const cwd = mkdtempSync(join(tmpdir(), 'modrex-i18n-writer-'))
    git(cwd, ['init', '-q', '-b', 'main'])
    git(cwd, ['config', 'user.email', 'writer@example.test'])
    git(cwd, ['config', 'user.name', 'Writer Test'])
    git(cwd, ['config', 'commit.gpgsign', 'false'])
    git(cwd, ['config', 'core.autocrlf', 'false'])
    mkdirSync(join(cwd, LOCALE_DIR), { recursive: true })
    mkdirSync(join(cwd, 'assets/i18n/status/legend'), { recursive: true })
    writeFileSync(join(cwd, LOCALE_DIR, 'en.json'), serializeLocale({ greet: 'Hello' }))
    writeFileSync(join(cwd, LOCALE_DIR, 'de.json'), serializeLocale({ greet: 'Hallo' }))
    writeFileSync(join(cwd, 'README.md'), README('old table'))
    writeFileSync(join(cwd, 'assets/i18n/status/de.svg'), '<svg/>\n')
    writeFileSync(join(cwd, 'assets/i18n/status/legend/accepted.svg'), '<svg/>\n')
    git(cwd, ['add', '-A'])
    git(cwd, ['commit', '-q', '-m', 'base'])
    return { cwd, base: git(cwd, ['rev-parse', 'HEAD']) }
}

function withRepo(run) {
    const fixture = createRepo()
    try {
        return run(fixture)
    } finally {
        rmSync(fixture.cwd, { recursive: true, force: true })
    }
}

function guard(fixture) {
    return checkWriterOutput({ cwd: fixture.cwd, base: fixture.base, localeDir: LOCALE_DIR })
}

test('only derived paths are writer output', () => {
    assert.equal(classifyWriterPath('README.md', LOCALE_DIR), 'readme')
    assert.equal(classifyWriterPath(`${LOCALE_DIR}/de.json`, LOCALE_DIR), 'locale')
    assert.equal(classifyWriterPath('assets/i18n/status/de.svg', LOCALE_DIR), 'status-asset')
    assert.equal(
        classifyWriterPath('apps/desktop/translation-contributors.generated.json', LOCALE_DIR),
        'contributors'
    )

    // English is the contributors' file and the legend is hand-maintained.
    assert.equal(classifyWriterPath(`${LOCALE_DIR}/en.json`, LOCALE_DIR), undefined)
    assert.equal(
        classifyWriterPath('assets/i18n/status/legend/accepted.svg', LOCALE_DIR),
        undefined
    )
    assert.equal(classifyWriterPath('apps/desktop/src-tauri/src/lib.rs', LOCALE_DIR), undefined)
    assert.equal(classifyWriterPath('CHANGELOG.md', LOCALE_DIR), undefined)
})

test('changed-path checking names every path the writer may not touch', () => {
    const result = checkChangedPaths(
        [`${LOCALE_DIR}/de.json`, `${LOCALE_DIR}/en.json`, 'README.md', 'src/App.tsx'],
        LOCALE_DIR
    )
    assert.deepEqual(result.locales, [`${LOCALE_DIR}/de.json`])
    assert.equal(result.errors.length, 2)
    assert.match(result.errors.join('\n'), /en\.json/u)
    assert.match(result.errors.join('\n'), /src\/App\.tsx/u)
})

test('adding and clearing a review marker preserves the payload', () => {
    for (const [from, to] of [
        [{ greet: 'Hallo' }, { greet: '? Hallo' }],
        [{ greet: '? Hallo' }, { greet: 'Hallo' }],
    ]) {
        assert.deepEqual(checkLocalePayloads('de', targets('de', from), targets('de', to)), [])
    }
})

test('refreshing and removing a scaffold preserves the payload', () => {
    assert.deepEqual(
        checkLocalePayloads('de', targets('de', { a: '! Old' }), targets('de', { a: '! New' })),
        []
    )
    assert.deepEqual(
        checkLocalePayloads('de', targets('de', { a: '! Old' }), targets('de', {})),
        []
    )
})

test('translated text may not be created, rewritten or removed', () => {
    const cases = [
        [{ greet: 'Hallo' }, { greet: 'Willkommen' }, /rewritten/u],
        [{ greet: 'Hallo' }, { greet: '? Willkommen' }, /rewritten/u],
        [{ greet: 'Hallo' }, {}, /removed/u],
        [{ greet: 'Hallo' }, { greet: '! Hello' }, /removed/u],
        [{ greet: '! Hello' }, { greet: 'Hallo' }, /became a translation/u],
        [{}, { greet: 'Hallo' }, /became a translation/u],
        [{ greet: '! Hello' }, { greet: '? Hallo' }, /became a translation/u],
    ]
    for (const [from, to, pattern] of cases) {
        const errors = checkLocalePayloads('de', targets('de', from), targets('de', to))
        assert.equal(errors.length, 1)
        assert.match(errors[0], pattern)
    }
})

test('README prose outside the generated block must survive', () => {
    assert.deepEqual(checkReadmeProse(README('old'), README('new')), [])
    assert.deepEqual(
        checkReadmeProse(README('old'), README('new').replace('Prose before.', 'Rewritten.')),
        ['README prose before the generated block changed']
    )
    assert.deepEqual(
        checkReadmeProse(README('old'), README('new').replace('Prose after.', 'Rewritten.')),
        ['README prose after the generated block changed']
    )
    assert.throws(
        () => checkReadmeProse('# No markers\n', README('new')),
        /generated translation block/u
    )
})

test('an ordinary bot tree passes the guard end to end', () => {
    withRepo((fixture) => {
        writeFileSync(
            join(fixture.cwd, LOCALE_DIR, 'de.json'),
            serializeLocale({ greet: '? Hallo' })
        )
        writeFileSync(join(fixture.cwd, 'README.md'), README('new table'))
        writeFileSync(join(fixture.cwd, 'assets/i18n/status/de.svg'), '<svg data-new=""/>\n')

        const result = guard(fixture)
        assert.deepEqual(result.errors, [])
        assert.equal(result.pass, true)
        assert.equal(result.locales.length, 1)
    })
})

test('the guard refuses an edited English source, a new language and a rewritten translation', () => {
    withRepo((fixture) => {
        writeFileSync(join(fixture.cwd, LOCALE_DIR, 'en.json'), serializeLocale({ greet: 'Hi' }))
        assert.match(guard(fixture).errors.join('\n'), /en\.json' is not a path/u)
    })
    withRepo((fixture) => {
        writeFileSync(join(fixture.cwd, LOCALE_DIR, 'fr.json'), serializeLocale({ greet: 'Salut' }))
        git(fixture.cwd, ['add', '-A'])
        assert.match(guard(fixture).errors.join('\n'), /may not create languages/u)
    })
    withRepo((fixture) => {
        writeFileSync(
            join(fixture.cwd, LOCALE_DIR, 'de.json'),
            serializeLocale({ greet: 'Willkommen' })
        )
        assert.match(guard(fixture).errors.join('\n'), /translated text rewritten/u)
    })
    withRepo((fixture) => {
        unlinkSync(join(fixture.cwd, LOCALE_DIR, 'de.json'))
        assert.match(guard(fixture).errors.join('\n'), /locale file was deleted/u)
    })
})

test('the guard refuses unrelated files and legend edits', () => {
    withRepo((fixture) => {
        writeFileSync(join(fixture.cwd, 'CHANGELOG.md'), 'edited\n')
        git(fixture.cwd, ['add', '-A'])
        assert.match(guard(fixture).errors.join('\n'), /CHANGELOG\.md' is not a path/u)
    })
    withRepo((fixture) => {
        writeFileSync(join(fixture.cwd, 'assets/i18n/status/legend/accepted.svg'), '<svg x=""/>\n')
        assert.match(guard(fixture).errors.join('\n'), /legend\/accepted\.svg' is not a path/u)
    })
})

test('an unchanged tree is allowed writer output and the CLI reports it', () => {
    withRepo((fixture) => {
        const stdout = {
            value: '',
            write(chunk) {
                this.value += chunk
            },
        }
        const stderr = {
            value: '',
            write(chunk) {
                this.value += chunk
            },
        }
        assert.equal(
            runI18nWriterGuard([fixture.base], {
                cwd: fixture.cwd,
                localeDir: LOCALE_DIR,
                stdout,
                stderr,
            }),
            0
        )
        assert.match(stdout.value, /writer output verified \(0 changed path\(s\)/u)
        assert.equal(stderr.value, '')
    })
})

test('the CLI reports a usage error without a base revision', () => {
    const stderr = {
        value: '',
        write(chunk) {
            this.value += chunk
        },
    }
    assert.equal(runI18nWriterGuard([], { stderr, stdout: { write() {} } }), 2)
    assert.match(stderr.value, /Usage: node scripts\/i18n-writer-guard\.mjs/u)
})

test('an untracked file is writer output too, because staging a directory would commit it', () => {
    withRepo((fixture) => {
        writeFileSync(join(fixture.cwd, LOCALE_DIR, 'fr.json'), serializeLocale({ greet: 'Salut' }))
        const result = guard(fixture)
        assert.equal(result.pass, false)
        assert.match(result.errors.join('\n'), /may not create languages/u)
        assert.deepEqual(result.changed, [`${LOCALE_DIR}/fr.json`])
    })
    withRepo((fixture) => {
        writeFileSync(join(fixture.cwd, 'assets/i18n/status/legend/new.svg'), '<svg/>\n')
        assert.match(guard(fixture).errors.join('\n'), /legend\/new\.svg' is not a path/u)
    })
})

test('the tree description distinguishes rewritten untracked content', () => {
    withRepo((fixture) => {
        const path = join(fixture.cwd, 'assets/i18n/status/fr.svg')
        const describe = () => describeWorkingTree({ cwd: fixture.cwd })

        writeFileSync(path, '<svg id="first"/>\n')
        const first = describe()

        // git status lists this file by name only, so a description built from names alone
        // would call the two passes identical and prove a fixed point that does not exist.
        writeFileSync(path, '<svg id="second"/>\n')
        const second = describe()
        assert.notEqual(first, second)

        writeFileSync(path, '<svg id="first"/>\n')
        assert.equal(describe(), first)
    })
})

test('the tree description is stable, and covers new, tracked and deleted paths', () => {
    withRepo((fixture) => {
        const describe = () => describeWorkingTree({ cwd: fixture.cwd })
        const clean = describe()
        assert.equal(clean, '')
        assert.equal(describe(), clean)

        writeFileSync(join(fixture.cwd, 'assets/i18n/status/fr.svg'), '<svg/>\n')
        const added = describe()
        assert.notEqual(added, clean)
        assert.match(added, /assets\/i18n\/status\/fr\.svg/u)

        writeFileSync(
            join(fixture.cwd, LOCALE_DIR, 'de.json'),
            serializeLocale({ greet: '? Hallo' })
        )
        const modified = describe()
        assert.notEqual(modified, added)

        unlinkSync(join(fixture.cwd, 'assets/i18n/status/de.svg'))
        const deleted = describe()
        assert.notEqual(deleted, modified)
        assert.match(deleted, /absent assets\/i18n\/status\/de\.svg/u)
    })
})
