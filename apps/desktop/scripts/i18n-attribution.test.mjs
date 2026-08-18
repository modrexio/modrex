import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { collectTranslationContributors, localeJsonChanged } from './update-i18n-contributors.mjs'

function locale(value) {
    return value === undefined ? undefined : JSON.stringify({ key: value })
}

function runGit(directory, args) {
    return execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim()
}

function temporaryHistory(states) {
    const directory = mkdtempSync(join(tmpdir(), 'modrex-i18n-attribution-'))
    runGit(directory, ['init', '-q'])
    runGit(directory, ['config', 'user.name', 'Fixture Default'])
    runGit(directory, ['config', 'user.email', 'fixture@example.test'])
    runGit(directory, ['config', 'core.autocrlf', 'false'])
    const commits = []
    try {
        for (const state of states) {
            writeFileSync(join(directory, 'en.json'), JSON.stringify({ key: state.source }))
            if (state.target === undefined) {
                rmSync(join(directory, 'de.json'), { force: true })
            } else {
                writeFileSync(join(directory, 'de.json'), state.target)
            }
            runGit(directory, ['add', '-A'])
            runGit(directory, [
                '-c',
                `user.name=${state.author}`,
                '-c',
                `user.email=${state.author.toLowerCase().replaceAll(' ', '-')}@example.test`,
                'commit',
                '-m',
                state.message ?? state.author,
                '--author',
                `${state.author} <${state.author.toLowerCase().replaceAll(' ', '-')}@example.test>`,
                '--quiet',
            ])
            const sha = runGit(directory, ['rev-parse', 'HEAD'])
            commits.push({ sha, parent: commits.at(-1)?.sha, author: state.author })
        }
        return {
            directory,
            commits,
            collect() {
                const apiCommits = commits
                    .slice()
                    .reverse()
                    .map((commit) => ({
                        sha: commit.sha,
                        parents: commit.parent ? [{ sha: commit.parent }] : [],
                        author: { type: 'User', login: commit.author },
                    }))
                return collectTranslationContributors(
                    ['de'],
                    (_localeId, page) => (page === 1 ? apiCommits : []),
                    (_localeId, commit) => {
                        const snapshot = (revision) => {
                            const path = runGit(directory, [
                                'ls-tree',
                                '--name-only',
                                revision,
                                '--',
                                'de.json',
                            ])
                            return path.length === 0
                                ? undefined
                                : runGit(directory, ['show', `${revision}:de.json`])
                        }
                        const current = snapshot(commit.sha)
                        const previousSha = commit.parents[0]?.sha
                        const previous = previousSha ? snapshot(previousSha) : undefined
                        if (current === undefined) return false
                        return localeJsonChanged(previous, current, 'de')
                    }
                )
            },
        }
    } catch (error) {
        rmSync(directory, { recursive: true, force: true })
        throw error
    }
}

async function withTemporaryHistory(states, callback) {
    const fixture = temporaryHistory(states)
    try {
        return await callback(fixture)
    } finally {
        rmSync(fixture.directory, { recursive: true, force: true })
    }
}

const noCreditTransitions = [
    ['absent to scaffold', undefined, '! English'],
    ['scaffold refresh', '! Old English', '! New English'],
    ['accepted to pending marker', 'X', '? X'],
    ['Keep', '? X', 'X'],
    ['source return clear', '? X', 'X'],
    ['target deletion', 'X', undefined],
    ['NFC-equivalent target edit', 'e\u0301', 'é'],
]

for (const [name, previous, current] of noCreditTransitions) {
    test(`attribution ignores ${name}`, () => {
        assert.equal(
            localeJsonChanged(
                locale(previous),
                current === undefined ? '{}' : locale(current),
                'de'
            ),
            false
        )
    })
}

const creditTransitions = [
    ['Pending to accepted edit', '? X', 'Y'],
    ['Pending edit remaining Pending', '? X', '? Y'],
    ['first translation over scaffold', '! English', 'Y'],
    ['first translation without scaffold', undefined, 'Y'],
    ['direct accepted edit', 'X', 'Y'],
    ['punctuation edit', 'Hello', 'Hello!'],
    ['capitalization edit', 'word', 'Word'],
    ['target whitespace edit', 'foo bar', 'foo  bar'],
]

for (const [name, previous, current] of creditTransitions) {
    test(`attribution credits ${name}`, () => {
        assert.equal(localeJsonChanged(locale(previous), locale(current), 'de'), true)
    })
}

test('attribution ignores formatting and object ordering', () => {
    const before = JSON.stringify({ group: { first: 'X', second: 'Y' } })
    const after = '{"group":{"second":"Y","first":"X"}}'
    assert.equal(localeJsonChanged(before, after, 'de'), false)
})

test('attribution credits canonical content changes in a mixed transition', () => {
    const before = JSON.stringify({
        scaffold: '! Old',
        marker: 'X',
        keep: '? A',
        pendingEdit: '? B',
        direct: 'D',
        removed: 'Gone',
    })
    const after = JSON.stringify({
        scaffold: '! New',
        marker: '? X',
        keep: 'A',
        pendingEdit: '? C',
        direct: 'E',
    })
    assert.equal(localeJsonChanged(before, after, 'de'), true)
})

test('marker-only maintenance across locales credits no source maintainer', async () => {
    const snapshots = new Map([
        ['de-marker', [locale('X'), locale('? X')]],
        ['ru-marker', [locale('X'), locale('? X')]],
        ['uk-scaffold', [locale(undefined), locale('! English')]],
    ])
    const contributors = await collectTranslationContributors(
        ['de', 'ru', 'uk'],
        (localeId, page) => {
            if (page > 1) return []
            const sha = localeId === 'uk' ? 'uk-scaffold' : `${localeId}-marker`
            return [
                {
                    sha,
                    parents: [{ sha: `${sha}-parent` }],
                    author: { type: 'User', login: 'SourceMaintainer' },
                },
            ]
        },
        (_localeId, commit) => {
            const [previous, current] = snapshots.get(commit.sha)
            return localeJsonChanged(previous, current, _localeId)
        }
    )
    assert.deepEqual(contributors, {})
})

test('pending edit remains attributable even while review is unresolved', async () => {
    const contributors = await collectTranslationContributors(
        ['de'],
        () => [
            {
                sha: 'pending-edit',
                parents: [{ sha: 'parent' }],
                author: { type: 'User', login: 'TranslatorB' },
            },
        ],
        () => localeJsonChanged(locale('? X'), locale('? Y'), 'de')
    )
    assert.deepEqual(contributors, { de: ['TranslatorB'] })
})

test('linked GitHub authors remain accumulated only for semantic target changes', async () => {
    const transitions = new Map([
        ['translator-a', [undefined, 'Y']],
        ['source-marker', ['Y', '? Y']],
        ['translator-b', ['Y', 'Z']],
        ['reviewer-keep', ['? Z', 'Z']],
    ])
    const contributors = await collectTranslationContributors(
        ['de'],
        (_localeId, page) =>
            page === 1
                ? [...transitions.keys()].map((sha, index) => ({
                      sha,
                      parents: [{ sha: `parent-${index}` }],
                      author: { type: 'User', login: sha },
                  }))
                : [],
        (_localeId, commit) => {
            const [previous, current] = transitions.get(commit.sha)
            return localeJsonChanged(locale(previous), locale(current), 'de')
        }
    )
    assert.deepEqual(contributors, { de: ['translator-a', 'translator-b'] })
})

test('linked marker-only identities are excluded while linked editors remain credited', async () => {
    const commits = [
        {
            sha: 'linked-marker',
            parents: [{ sha: 'parent-marker' }],
            author: { type: 'User', login: 'SquashedMarkerAuthor' },
        },
        {
            sha: 'linked-edit',
            parents: [{ sha: 'parent-edit' }],
            author: { type: 'User', login: 'SquashedTranslator' },
        },
        {
            sha: 'linked-merge',
            parents: [{ sha: 'one' }, { sha: 'two' }],
            author: { type: 'User', login: 'SquashedMarkerAuthor' },
        },
    ]
    const contributors = await collectTranslationContributors(
        ['de'],
        (_localeId, page) => (page === 1 ? commits : []),
        (_localeId, commit) => commit.sha === 'linked-edit'
    )
    assert.deepEqual(contributors, { de: ['SquashedTranslator'] })
})

test('real Git history credits pending edits but not source markers or Keep', async () => {
    await withTemporaryHistory(
        [
            { source: 'A', target: JSON.stringify({ key: 'X' }), author: 'Translator A' },
            { source: 'B', target: JSON.stringify({ key: '? X' }), author: 'Source Maintainer' },
            { source: 'B', target: JSON.stringify({ key: '? Y' }), author: 'Translator B' },
            { source: 'B', target: JSON.stringify({ key: 'Y' }), author: 'Reviewer C' },
            { source: 'C', target: JSON.stringify({ key: 'Z' }), author: 'Translator E' },
        ],
        async (fixture) => {
            assert.deepEqual(await fixture.collect(), {
                de: ['Translator A', 'Translator B', 'Translator E'],
            })
        }
    )
})

test('real Git source and target changes classify marker and content transitions', async () => {
    await withTemporaryHistory(
        [
            { source: 'A', target: JSON.stringify({ key: 'X' }), author: 'Translator A' },
            { source: 'B', target: JSON.stringify({ key: 'Y' }), author: 'Translator B' },
            { source: 'C', target: JSON.stringify({ key: '? Y' }), author: 'Source Maintainer' },
            { source: 'D', target: JSON.stringify({ key: 'Z' }), author: 'Translator D' },
        ],
        async (fixture) => {
            assert.deepEqual(await fixture.collect(), {
                de: ['Translator A', 'Translator B', 'Translator D'],
            })
        }
    )
})

test('real Git deletion receives no credit and recreation receives credit', async () => {
    await withTemporaryHistory(
        [
            { source: 'A', target: JSON.stringify({ key: 'X' }), author: 'Translator A' },
            { source: 'A', target: undefined, author: 'Source Maintainer' },
            { source: 'A', target: JSON.stringify({ key: 'Y' }), author: 'Translator C' },
        ],
        async (fixture) => {
            assert.deepEqual(await fixture.collect(), { de: ['Translator A', 'Translator C'] })
        }
    )
})

test('real Git locale creation credits translations but not scaffolds', async () => {
    await withTemporaryHistory(
        [
            { source: 'A', target: undefined, author: 'Source Maintainer' },
            {
                source: 'A',
                target: JSON.stringify({
                    scaffold: '! English',
                    translated: 'Übersetzung',
                }),
                author: 'Translator A',
            },
        ],
        async (fixture) => {
            assert.deepEqual(await fixture.collect(), { de: ['Translator A'] })
        }
    )
})

test('real Git formatting-only changes receive no credit', async () => {
    await withTemporaryHistory(
        [
            {
                source: 'A',
                target: '{\n    "one": "X",\n    "two": "Y"\n}\n',
                author: 'Translator A',
            },
            {
                source: 'A',
                target: '{"two":"Y","one":"X"}',
                author: 'Formatter B',
            },
        ],
        async (fixture) => {
            assert.deepEqual(await fixture.collect(), { de: ['Translator A'] })
        }
    )
})

test('malformed historical target leaves fail closed through real Git collection', async () => {
    await assert.rejects(
        withTemporaryHistory(
            [
                { source: 'A', target: JSON.stringify({ key: 'X' }), author: 'Translator A' },
                { source: 'A', target: JSON.stringify({ key: 42 }), author: 'Broken Commit' },
            ],
            (fixture) => fixture.collect()
        ),
        /Invalid historical locale 'de'.*must be a string or object/s
    )
})

test('malformed target marker syntax remains rejected', () => {
    assert.throws(
        () => localeJsonChanged(locale('X'), locale('? ? X'), 'de'),
        /Could not compare historical JSON for locale 'de'/
    )
})

test('non-string historical target leaves fail closed', () => {
    for (const invalid of ['42', 'null', '["x"]']) {
        assert.throws(
            () => localeJsonChanged('{"key":"X"}', `{"key":${invalid}}`, 'de'),
            /Invalid historical locale 'de'.*must be a string or object/s
        )
    }
})
