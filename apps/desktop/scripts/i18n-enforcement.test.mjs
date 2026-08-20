import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
    checkI18nSnapshot,
    checkStagedI18n,
    formatWorkflowSummary,
    runI18nEnforcement,
    summarizeWorkflow,
} from './i18n-enforcement.mjs'
import { HISTORY_EVENT } from './i18n-history-events.mjs'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function fixture(initialSource = 'A', initialTarget = 'X') {
    const cwd = mkdtempSync(join(tmpdir(), 'modrex-i18n-enforcement-'))
    git(cwd, ['init', '-q'])
    git(cwd, ['config', 'user.name', 'Stage 10 Fixture'])
    git(cwd, ['config', 'user.email', 'stage10@example.test'])
    git(cwd, ['config', 'core.autocrlf', 'false'])
    const localeDir = join(cwd, 'i18n')
    mkdirSync(localeDir, { recursive: true })
    const write = (source, target, extra = {}) => {
        writeFileSync(join(localeDir, 'en.json'), JSON.stringify({ key: source }))
        writeFileSync(join(localeDir, 'de.json'), JSON.stringify({ key: target, ...extra }))
    }
    writeFileSync(join(localeDir, 'en.json'), JSON.stringify({ key: initialSource }))
    writeFileSync(join(localeDir, 'de.json'), JSON.stringify({ key: initialTarget }))
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '-qm', 'baseline'])
    const baseline = git(cwd, ['rev-parse', 'HEAD'])
    return { cwd, baseline, write }
}

function multiFixture() {
    const cwd = mkdtempSync(join(tmpdir(), 'modrex-i18n-enforcement-multi-'))
    git(cwd, ['init', '-q'])
    git(cwd, ['config', 'user.name', 'Stage 10 Multi Fixture'])
    git(cwd, ['config', 'user.email', 'stage10-multi@example.test'])
    const localeDir = join(cwd, 'i18n')
    mkdirSync(localeDir, { recursive: true })
    const write = (source, values) => {
        writeFileSync(join(localeDir, 'en.json'), JSON.stringify({ key: source }))
        for (const locale of ['de', 'ru', 'uk']) {
            writeFileSync(
                join(localeDir, `${locale}.json`),
                JSON.stringify({ key: values[locale] })
            )
        }
    }
    write('A', { de: 'X', ru: 'X', uk: 'X' })
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '-qm', 'baseline'])
    return { cwd, baseline: git(cwd, ['rev-parse', 'HEAD']), localeDir, write }
}

async function withFixture(callback) {
    const value = fixture()
    try {
        return await callback(value)
    } finally {
        rmSync(value.cwd, { recursive: true, force: true })
    }
}

test('unrelated staged paths skip history analysis', async () => {
    await withFixture(({ cwd, baseline }) => {
        writeFileSync(join(cwd, 'notes.txt'), 'unrelated')
        git(cwd, ['add', 'notes.txt'])
        const result = checkStagedI18n({ cwd, baseline, localeDir: 'i18n' })
        assert.equal(result.skipped, true)
        assert.equal(result.pass, true)
    })
})

test('staged English drift fails and ignores an unstaged synchronized fix', async () => {
    await withFixture(({ cwd, baseline, write }) => {
        write('B', 'X')
        git(cwd, ['add', 'i18n/en.json'])
        write('B', '? X')
        const before = readFileSync(join(cwd, 'i18n', 'de.json'))
        const result = checkStagedI18n({ cwd, baseline, localeDir: 'i18n' })
        assert.equal(result.pass, false)
        assert.deepEqual(readFileSync(join(cwd, 'i18n', 'de.json')), before)
    })
})

test('canonical index passes despite a broken unstaged worktree file', async () => {
    await withFixture(({ cwd, baseline, write }) => {
        write('B', '? X')
        git(cwd, ['add', 'i18n/en.json', 'i18n/de.json'])
        write('B', 'X')
        const result = checkStagedI18n({ cwd, baseline, localeDir: 'i18n' })
        assert.equal(result.pass, true)
    })
})

test('same-file staged blob purity rejects a stale indexed target', async () => {
    await withFixture(({ cwd, baseline }) => {
        writeFileSync(join(cwd, 'i18n', 'de.json'), JSON.stringify({ key: '! Old' }))
        git(cwd, ['add', 'i18n/de.json'])
        writeFileSync(join(cwd, 'i18n', 'de.json'), JSON.stringify({ key: 'X' }))
        const result = checkStagedI18n({ cwd, baseline, localeDir: 'i18n' })
        assert.equal(result.pass, false)
    })
})

test('complete staged source and marker transition passes', async () => {
    await withFixture(({ cwd, baseline, write }) => {
        write('B', '? X')
        git(cwd, ['add', 'i18n/en.json', 'i18n/de.json'])
        const result = checkStagedI18n({ cwd, baseline, localeDir: 'i18n' })
        assert.equal(result.pass, true)
    })
})

test('staged new source keys require exact scaffolds', async () => {
    await withFixture(({ cwd, baseline }) => {
        writeFileSync(join(cwd, 'i18n', 'en.json'), JSON.stringify({ key: 'A', added: 'New' }))
        git(cwd, ['add', 'i18n/en.json'])
        assert.equal(checkStagedI18n({ cwd, baseline, localeDir: 'i18n' }).pass, false)
        writeFileSync(join(cwd, 'i18n', 'de.json'), JSON.stringify({ key: 'X', added: '! New' }))
        git(cwd, ['add', 'i18n/de.json'])
        assert.equal(checkStagedI18n({ cwd, baseline, localeDir: 'i18n' }).pass, true)
    })
})

test('staged explicit review request remains canonical', async () => {
    await withFixture(({ cwd, baseline }) => {
        writeFileSync(join(cwd, 'i18n', 'de.json'), JSON.stringify({ key: '? X' }))
        git(cwd, ['add', 'i18n/de.json'])
        assert.equal(checkStagedI18n({ cwd, baseline, localeDir: 'i18n' }).pass, true)
    })
})

test('partial multi-locale staging cannot be rescued by a synchronized worktree', async () => {
    const value = multiFixture()
    try {
        value.write('B', { de: '? X', ru: 'X', uk: 'X' })
        git(value.cwd, ['add', 'i18n/en.json', 'i18n/de.json'])
        value.write('B', { de: '? X', ru: '? X', uk: '? X' })
        assert.equal(
            checkStagedI18n({ cwd: value.cwd, baseline: value.baseline, localeDir: 'i18n' }).pass,
            false
        )
        git(value.cwd, ['add', 'i18n/ru.json', 'i18n/uk.json'])
        assert.equal(
            checkStagedI18n({ cwd: value.cwd, baseline: value.baseline, localeDir: 'i18n' }).pass,
            true
        )
    } finally {
        rmSync(value.cwd, { recursive: true, force: true })
    }
})

test('staged Edit and Pending Edit remain in their resulting states', async () => {
    await withFixture(({ cwd, baseline, write }) => {
        write('A', '? X')
        git(cwd, ['add', 'i18n/de.json'])
        git(cwd, ['commit', '-qm', 'request review'])
        write('A', 'Y')
        git(cwd, ['add', 'i18n/de.json'])
        const edit = checkStagedI18n({ cwd, baseline, localeDir: 'i18n' })
        assert.equal(edit.pass, true)
        assert.equal(edit.workflowSummary.targetContentEdits.length, 1)
        write('A', '? Y')
        git(cwd, ['add', 'i18n/de.json'])
        const pendingEdit = checkStagedI18n({ cwd, baseline, localeDir: 'i18n' })
        assert.equal(pendingEdit.pass, true)
        assert.equal(pendingEdit.workflowSummary.targetContentEdits.length, 1)
    })
})

test('source-return clear requires the staged marker to be removed', async () => {
    await withFixture(({ cwd, baseline }) => {
        writeFileSync(join(cwd, 'i18n', 'en.json'), JSON.stringify({ key: 'B' }))
        writeFileSync(join(cwd, 'i18n', 'de.json'), JSON.stringify({ key: '? X' }))
        git(cwd, ['add', 'i18n/en.json', 'i18n/de.json'])
        git(cwd, ['commit', '-qm', 'source changed'])
        writeFileSync(join(cwd, 'i18n', 'en.json'), JSON.stringify({ key: 'A' }, null, 2))
        git(cwd, ['add', 'i18n/en.json'])
        git(cwd, ['commit', '-qm', 'source returned'])
        writeFileSync(join(cwd, 'i18n', 'en.json'), JSON.stringify({ key: 'A' }))
        git(cwd, ['add', 'i18n/en.json'])
        const retained = checkStagedI18n({ cwd, baseline, localeDir: 'i18n' })
        assert.equal(retained.pass, false)
        writeFileSync(join(cwd, 'i18n', 'de.json'), JSON.stringify({ key: 'X' }))
        git(cwd, ['add', 'i18n/de.json'])
        const cleared = checkStagedI18n({ cwd, baseline, localeDir: 'i18n' })
        assert.equal(cleared.pass, true)
        assert.equal(cleared.workflowSummary.sourceReturnClears.length, 1)
        assert.equal(cleared.workflowSummary.keeps.length, 0)
    })
})

test('incompatible Keep fails while the incompatible Pending state remains valid', async () => {
    const value = fixture()
    try {
        writeFileSync(join(value.cwd, 'i18n', 'en.json'), JSON.stringify({ key: 'Hello {name}' }))
        git(value.cwd, ['add', 'i18n/en.json'])
        git(value.cwd, ['commit', '-qm', 'source changed'])
        writeFileSync(join(value.cwd, 'i18n', 'de.json'), JSON.stringify({ key: '? Hallo {user}' }))
        git(value.cwd, ['add', 'i18n/de.json'])
        assert.equal(
            checkStagedI18n({ cwd: value.cwd, baseline: value.baseline, localeDir: 'i18n' }).pass,
            true
        )
        writeFileSync(join(value.cwd, 'i18n', 'de.json'), JSON.stringify({ key: 'Hallo {user}' }))
        git(value.cwd, ['add', 'i18n/de.json'])
        assert.throws(
            () => checkStagedI18n({ cwd: value.cwd, baseline: value.baseline, localeDir: 'i18n' }),
            /interpolation vars/u
        )
    } finally {
        rmSync(value.cwd, { recursive: true, force: true })
    }
})

test('obsolete human target content blocks checked-out enforcement', async () => {
    await withFixture(({ cwd, baseline }) => {
        writeFileSync(join(cwd, 'i18n', 'en.json'), JSON.stringify({ other: 'A' }))
        writeFileSync(join(cwd, 'i18n', 'de.json'), JSON.stringify({ key: 'X', other: '! A' }))
        assert.throws(
            () => checkI18nSnapshot({ cwd, baseline, localeDir: 'i18n' }),
            /cannot delete target-language content/u
        )
    })
})

test('relevant shallow history fails while unrelated staged work skips', async () => {
    const source = fixture()
    const clone = mkdtempSync(join(tmpdir(), 'modrex-i18n-enforcement-shallow-'))
    try {
        source.write('B', 'X')
        git(source.cwd, ['add', 'i18n/en.json'])
        git(source.cwd, ['commit', '-qm', 'after baseline'])
        git(source.cwd, [
            'clone',
            '--quiet',
            '--depth',
            '1',
            `file:///${source.cwd.replaceAll('\\', '/')}`,
            clone,
        ])
        assert.equal(git(clone, ['rev-parse', '--is-shallow-repository']), 'true')
        writeFileSync(join(clone, 'notes.txt'), 'unrelated')
        git(clone, ['add', 'notes.txt'])
        assert.equal(
            checkStagedI18n({ cwd: clone, baseline: source.baseline, localeDir: 'i18n' }).skipped,
            true
        )
        writeFileSync(join(clone, 'i18n', 'en.json'), JSON.stringify({ key: 'C' }))
        git(clone, ['add', 'i18n/en.json'])
        assert.throws(
            () =>
                checkStagedI18n({
                    cwd: clone,
                    baseline: '1111111111111111111111111111111111111111',
                    localeDir: 'i18n',
                }),
            /Full i18n history|baseline|history/u
        )
    } finally {
        rmSync(source.cwd, { recursive: true, force: true })
        rmSync(clone, { recursive: true, force: true })
    }
})

test('checked-out enforcement follows the observable merged final tree', async () => {
    await withFixture(({ cwd, baseline }) => {
        const baseBranch = git(cwd, ['branch', '--show-current'])
        git(cwd, ['switch', '-c', 'translation-side'])
        writeFileSync(join(cwd, 'i18n', 'de.json'), JSON.stringify({ key: 'Y' }))
        git(cwd, ['add', 'i18n/de.json'])
        git(cwd, ['commit', '-qm', 'side translation'])
        git(cwd, ['switch', baseBranch])
        git(cwd, ['merge', '--no-ff', '-qm', 'merge translation-side', 'translation-side'])

        const result = checkI18nSnapshot({ cwd, baseline, localeDir: 'i18n' })
        assert.equal(result.pass, true)
        assert.equal(result.history.snapshot.locales.get('de').targets.get('key').targetText, 'Y')
    })
})

test('staged Keep is evaluated from the index, not the worktree', async () => {
    await withFixture(({ cwd, baseline, write }) => {
        write('A', 'X')
        git(cwd, ['add', 'i18n/de.json'])
        write('A', '? X')
        const result = checkStagedI18n({ cwd, baseline, localeDir: 'i18n' })
        assert.equal(result.pass, true)
    })
})

test('Pending placeholder mismatch remains nonblocking', async () => {
    await withFixture(({ cwd, baseline }) => {
        writeFileSync(join(cwd, 'i18n', 'en.json'), JSON.stringify({ key: 'Hello {name}' }))
        writeFileSync(join(cwd, 'i18n', 'de.json'), JSON.stringify({ key: '? Hallo {user}' }))
        git(cwd, ['add', 'i18n/en.json', 'i18n/de.json'])
        const result = checkStagedI18n({ cwd, baseline, localeDir: 'i18n' })
        assert.equal(result.pass, true)
    })
})

test('working-tree checker is read-only and reports canonical drift', async () => {
    await withFixture(({ cwd, baseline, write }) => {
        write('B', 'X')
        const before = readFileSync(join(cwd, 'i18n', 'de.json'))
        const result = checkI18nSnapshot({ cwd, baseline, localeDir: 'i18n' })
        assert.equal(result.pass, false)
        assert.deepEqual(readFileSync(join(cwd, 'i18n', 'de.json')), before)
    })
})

test('ordering drift fails even when semantic operations are empty', async () => {
    await withFixture(({ cwd, baseline }) => {
        writeFileSync(join(cwd, 'i18n', 'en.json'), JSON.stringify({ first: 'A', second: 'B' }))
        writeFileSync(join(cwd, 'i18n', 'de.json'), JSON.stringify({ second: 'B', first: 'A' }))
        const result = checkI18nSnapshot({ cwd, baseline, localeDir: 'i18n' })
        assert.equal(result.pass, false)
        assert.equal(result.operations[0].kind, 'serialization-drift')
    })
})

test('malformed markers fail before producing a pass result', async () => {
    await withFixture(({ cwd, baseline }) => {
        writeFileSync(join(cwd, 'i18n', 'de.json'), JSON.stringify({ key: '? ' }))
        git(cwd, ['add', 'i18n/de.json'])
        assert.throws(
            () => checkStagedI18n({ cwd, baseline, localeDir: 'i18n' }),
            /marker|Pending|workflow/i
        )
    })
})

test('repository enforcement wiring is read-only and full-history', () => {
    const workflow = readFileSync(join(REPOSITORY_ROOT, '.github/workflows/ci.yml'), 'utf8')
    const hook = readFileSync(join(REPOSITORY_ROOT, '.husky/pre-commit'), 'utf8')
    assert.match(workflow, /fetch-depth:\s*0/u)
    assert.match(workflow, /pnpm i18n:check-readonly/u)
    assert.doesNotMatch(workflow, /pnpm i18n:sync/u)
    assert.match(hook, /pnpm i18n:check-staged/u)
    assert.match(hook, /CI enforces this check/u)
    const i18nHookLine = hook.split('\n').find((line) => line.includes('pnpm i18n:check-staged'))
    assert.ok(i18nHookLine)
    assert.doesNotMatch(i18nHookLine, /exit 1/u)
    assert.doesNotMatch(hook, /pnpm i18n:sync/u)
    assert.doesNotMatch(hook, /git add .*i18n/u)
    assert.doesNotMatch(workflow, /continue-on-error/u)
})

test('workflow summary classifies base-to-prospective events independently of validity', () => {
    const events = [
        ...Array.from({ length: 10 }, () => HISTORY_EVENT.KEEP),
        HISTORY_EVENT.SOURCE_TRIGGERED_PENDING,
        HISTORY_EVENT.PENDING_EDIT,
        HISTORY_EVENT.ACCEPTED_EDIT,
        HISTORY_EVENT.SCAFFOLD_CREATED,
        HISTORY_EVENT.SCAFFOLD_REFRESHED,
        HISTORY_EVENT.SOURCE_RETURN_CLEARED,
    ].map((kind, index) => ({ kind, locale: 'de', key: `key${index}` }))
    const summary = summarizeWorkflow({
        history: { prospectiveEvents: events },
        baseSnapshot: { locales: new Map() },
        currentSnapshot: { locales: new Map() },
    })
    assert.equal(summary.keeps.length, 10)
    assert.equal(summary.newlyPending.length, 1)
    assert.equal(summary.targetContentEdits.length, 2)
    assert.equal(summary.scaffoldsAdded.length, 1)
    assert.equal(summary.scaffoldsRefreshed.length, 1)
    assert.equal(summary.sourceReturnClears.length, 1)
    assert.match(formatWorkflowSummary(summary), /accepted unchanged \/ Keeps: 10/u)
})

test('direct checker commands remain strict while integrations are advisory', async () => {
    await withFixture(({ cwd, baseline, write }) => {
        write('B', 'X')
        const stdout = { write() {} }
        const stderr = { write() {} }
        assert.equal(
            runI18nEnforcement([], { cwd, baseline, localeDir: 'i18n', stdout, stderr }),
            1
        )
        git(cwd, ['add', 'i18n/en.json'])
        assert.equal(
            runI18nEnforcement(['--staged'], {
                cwd,
                baseline,
                localeDir: 'i18n',
                stdout,
                stderr,
            }),
            1
        )
    })
})
