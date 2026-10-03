import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createGitAdapter } from './i18n-git.mts'
import { analyzeCommittedHistory } from './i18n-history.mts'

function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

test('batched trees match ls-tree through unrelated work, renames, modes, deletion and gitlinks', (t) => {
    const cwd = mkdtempSync(join(tmpdir(), 'modrex-i18n-git-batch-'))
    t.after(() => rmSync(cwd, { recursive: true, force: true }))
    git(cwd, ['init', '-q', '-b', 'main'])
    git(cwd, ['config', 'user.name', 'Git Test'])
    git(cwd, ['config', 'user.email', 'git@example.test'])
    git(cwd, ['config', 'commit.gpgsign', 'false'])
    git(cwd, ['config', 'core.autocrlf', 'false'])
    mkdirSync(join(cwd, 'i18n'))
    writeFileSync(join(cwd, 'i18n/en.json'), '{"a":"A"}')
    writeFileSync(join(cwd, 'i18n/de.json'), '{"a":"X"}')
    git(cwd, ['add', '-A'])
    git(cwd, ['commit', '-qm', 'baseline'])
    const baseline = git(cwd, ['rev-parse', 'HEAD'])
    const blob = git(cwd, ['rev-parse', 'HEAD:i18n/de.json'])
    writeFileSync(join(cwd, 'unrelated'), 'unrelated')
    git(cwd, ['add', '-A'])
    git(cwd, ['commit', '-qm', 'unrelated'])
    for (const mode of ['100755', '120000', '160000', '100644']) {
        git(cwd, [
            'update-index',
            '--cacheinfo',
            mode + ',' + (mode === '160000' ? baseline : blob) + ',i18n/de.json',
        ])
        git(cwd, ['commit', '-qm', 'mode ' + mode])
    }
    renameSync(join(cwd, 'i18n/de.json'), join(cwd, 'i18n/fr.json'))
    git(cwd, ['add', '-A'])
    git(cwd, ['commit', '-qm', 'rename'])
    rmSync(join(cwd, 'i18n/fr.json'))
    git(cwd, ['add', '-A'])
    git(cwd, ['commit', '-qm', 'delete'])
    writeFileSync(join(cwd, 'i18n/fr.json'), '{"a":"Y"}')
    git(cwd, ['add', '-A'])
    git(cwd, ['commit', '-qm', 'recreate'])
    const adapter = createGitAdapter({ cwd })
    const revisions = [baseline, ...adapter.firstParentRevisions(baseline, 'HEAD', 'i18n')]
    const before = adapter.counters.gitCalls
    const trees = adapter.treesAtRevisions(revisions, 'i18n')
    assert.equal(adapter.counters.gitCalls - before, 2)
    for (const [revision, tree] of trees)
        assert.deepEqual([...tree], [...adapter.treeBlobs(revision, 'i18n')])
    const batched = analyzeCommittedHistory({ cwd, baseline, localeDir: 'i18n' })
    const unbatchedAdapter = createGitAdapter({ cwd })
    delete unbatchedAdapter.treesAtRevisions
    const unbatched = analyzeCommittedHistory({
        cwd,
        baseline,
        localeDir: 'i18n',
        git: unbatchedAdapter,
    })
    const { stats: batchedStats, ...batchedResult } = batched
    const { stats: unbatchedStats, ...unbatchedResult } = unbatched
    assert.deepEqual(batchedResult, unbatchedResult)
    assert.equal(batchedStats.gitCalls, 8)
    assert.equal(unbatchedStats.gitCalls, 6 + revisions.length)
})

const baseline = 'a'.repeat(40)
const revision = 'b'.repeat(40)
const oldBlob = 'c'.repeat(40)
const newBlob = 'd'.repeat(40)
const record = ':100644 100644 ' + oldBlob + ' ' + newBlob + ' M'
function adapterWithOutput(output) {
    return createGitAdapter({
        cwd: '.',
        run: (args) => ({
            status: 0,
            stderr: Buffer.alloc(0),
            stdout: Buffer.from(
                args[0] === 'ls-tree' ? '100644 blob ' + oldBlob + '\ti18n/de.json\0' : output
            ),
        }),
    })
}

test('NUL framing preserves tabs and newlines in diff paths', () => {
    const path = 'i18n/tab\tline\n.json'
    const output =
        revision + '\0:000000 100644 ' + '0'.repeat(40) + ' ' + newBlob + ' A\0' + path + '\0'
    assert.equal(
        adapterWithOutput(output)
            .treesAtRevisions([baseline, revision], 'i18n')
            .get(revision)
            .get(path),
        newBlob
    )
})

for (const [name, output] of [
    ['missing revision', ''],
    ['unterminated record', revision + '\0' + record + '\0i18n/de.json'],
    ['wrong revision', baseline + '\0'],
    ['changes before revision', record + '\0i18n/de.json\0'],
    ['invalid record', revision + '\0:broken\0i18n/de.json\0'],
    ['missing path', revision + '\0' + record + '\0'],
    ['out-of-scope path', revision + '\0' + record + '\0elsewhere/de.json\0'],
    [
        'wrong previous object',
        revision + '\0' + record.replace(oldBlob, newBlob) + '\0i18n/de.json\0',
    ],
    [
        'unsupported mode',
        revision + '\0' + record.replace('100644 100644', '100644 100600') + '\0i18n/de.json\0',
    ],
    ['empty intermediate record', revision + '\0\0'],
]) {
    test('malformed diff transport refuses ' + name, () => {
        assert.throws(
            () => adapterWithOutput(output).treesAtRevisions([baseline, revision], 'i18n'),
            /git diff-tree/
        )
    })
}
