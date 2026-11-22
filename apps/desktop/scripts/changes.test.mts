import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import {
    collectNotes,
    parseChange,
    parseCoAuthors,
    renderNightly,
    renderRelease,
    type CoAuthors,
    type CommitInfo,
    type GitActor,
    type GitHub,
    type PullInfo,
} from './changes.mts'

const PULL = 'https://github.com/modrexio/modrex/pull'

function git(cwd: string, args: string[]) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

const actor = (name: string, email: string, login: string | null = null): GitActor => ({
    name,
    email,
    login,
})
const maintainer = actor('Oleh Shulha', 'oleh@example.test', 'ShulhaOleh')
const jane = actor('Jane', 'jane@mail.test')
const illia = actor('Illia', 'illia@mail.test')
const aiTool = actor('Claude', 'noreply@anthropic.com')
const actionsBot = actor('github-actions[bot]', 'actions@example.test', 'github-actions[bot]')

const pull = (login: string, coAuthors: GitActor[], bot = false): PullInfo => ({
    author: { login, bot },
    coAuthors,
})

// The history a release range sees: two change files, a PR that edits one of them, a direct
// push by a bot, and a maintainer PR with a co-author that has no GitHub account.
function fixture(t: TestContext) {
    const cwd = mkdtempSync(join(tmpdir(), 'modrex-changes-'))
    t.after(() => rmSync(cwd, { recursive: true, force: true }))
    git(cwd, ['init', '-q', '-b', 'main'])
    git(cwd, ['config', 'user.name', 'Git Test'])
    git(cwd, ['config', 'user.email', 'git@example.test'])
    git(cwd, ['config', 'commit.gpgsign', 'false'])
    git(cwd, ['config', 'core.autocrlf', 'false'])
    mkdirSync(join(cwd, '.changes'))
    const commit = (message: string, files: Record<string, string>) => {
        for (const [file, text] of Object.entries(files)) writeFileSync(join(cwd, file), text)
        git(cwd, ['add', '-A'])
        git(cwd, ['commit', '-q', '--allow-empty', '-m', message])
        return git(cwd, ['rev-parse', 'HEAD'])
    }
    commit('released work', { 'app.txt': 'one' })
    git(cwd, ['tag', 'v1.0.0'])
    const shas = [
        commit('add profiles (#10)', {
            '.changes/profiles.md': '---\ncategory: added\n---\nAdded profiles.\n',
        }),
        commit('fix updates (#11)', {
            '.changes/updates.md':
                '---\ncategory: fixed\nprs: [7]\nthanks: [@carol, basic_futon (Discord)]\n---\nFixed update\nchecks.\n',
        }),
        commit('fix profiles (#12)', {
            '.changes/profiles.md': '---\ncategory: added\n---\nAdded mod profiles.\n',
        }),
        commit('docs: update translation status', { 'status.txt': 'bot' }),
        commit('refactor (#13)', { 'app.txt': 'two' }),
    ]
    const commits = new Map<string, CommitInfo>([
        [shas[0]!, { pr: 10, authors: [] }],
        [shas[1]!, { pr: 11, authors: [] }],
        [shas[2]!, { pr: 12, authors: [] }],
        [shas[3]!, { pr: null, authors: [actionsBot] }],
        [shas[4]!, { pr: 13, authors: [] }],
    ])
    const pulls = new Map<number, PullInfo>([
        [7, pull('bob', [])],
        [10, pull('alice', [actor('Alice', 'alice@example.test', 'alice'), maintainer])],
        [11, pull('ShulhaOleh', [maintainer])],
        [12, pull('dave', [jane, aiTool])],
        [13, pull('ShulhaOleh', [maintainer, illia])],
    ])
    const github: GitHub = {
        commits: (wanted) => new Map(wanted.map((sha) => [sha, commits.get(sha)!])),
        pulls: (wanted) => new Map(wanted.map((number) => [number, pulls.get(number)!])),
    }
    return { cwd, shas, github }
}

const classified: CoAuthors = {
    people: new Set(['jane@mail.test', 'illia@mail.test']),
    bots: new Set(['noreply@anthropic.com']),
}

test('entries link their PRs and credit non-maintainer authors and co-authors', (t) => {
    const { cwd, github } = fixture(t)
    const warnings: string[] = []
    const notes = collectNotes({
        repoRoot: cwd,
        github,
        coAuthors: classified,
        unknownCoAuthors: 'fail',
        warn: (message) => warnings.push(message),
    })
    assert.deepEqual(warnings, [])
    assert.equal(
        renderRelease(notes),
        [
            '### Added',
            '',
            `- Added mod profiles. ([#10](${PULL}/10), [#12](${PULL}/12) by [@alice](https://github.com/alice), [@dave](https://github.com/dave), Jane)`,
            '',
            '### Fixed',
            '',
            `- Fixed update checks. ([#7](${PULL}/7) by [@bob](https://github.com/bob), thanks to [@carol](https://github.com/carol), basic\\_futon (Discord))`,
            '',
            '### Contributors',
            '',
            'Thank you to everyone who contributed to this release: [@alice](https://github.com/alice), [@dave](https://github.com/dave), Illia, Jane, [@ShulhaOleh](https://github.com/ShulhaOleh)',
        ].join('\n')
    )
})

test('a release stops on a co-author nobody has classified', (t) => {
    const { cwd, github } = fixture(t)
    assert.throws(
        () =>
            collectNotes({
                repoRoot: cwd,
                github,
                coAuthors: { people: new Set(['jane@mail.test']), bots: classified.bots },
                unknownCoAuthors: 'fail',
                warn: () => {},
            }),
        /Illia <illia@mail\.test>[\s\S]*Add each email to people or bots/
    )
})

test('a nightly leaves an unclassified co-author out and warns', (t) => {
    const { cwd, github } = fixture(t)
    const warnings: string[] = []
    const notes = collectNotes({
        repoRoot: cwd,
        github,
        coAuthors: { people: new Set(['jane@mail.test']), bots: classified.bots },
        unknownCoAuthors: 'skip',
        warn: (message) => warnings.push(message),
    })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!, /Illia <illia@mail\.test>[\s\S]*left out/)
    assert.deepEqual(
        notes.contributors.map((person) => person.name),
        ['alice', 'dave', 'Jane', 'ShulhaOleh']
    )
})

test('nightly notes list files changed since the previous nightly, then everything', (t) => {
    const { cwd, shas, github } = fixture(t)
    const notes = collectNotes({
        repoRoot: cwd,
        github,
        coAuthors: classified,
        unknownCoAuthors: 'skip',
        warn: () => {},
    })
    const sinceNightly = new Set(git(cwd, ['rev-list', `${shas[1]}..HEAD`]).split('\n'))
    const body = renderNightly(notes, sinceNightly)
    const [fresh, everything] = body.split('\n\n## Everything since v1.0.0\n\n')
    assert.match(fresh!, /^## New in this build\n\n### Added\n\n- Added mod profiles\./)
    assert.doesNotMatch(fresh!, /Fixed update checks/)
    assert.equal(everything, renderRelease(notes))

    const quiet = renderNightly(notes, new Set<string>())
    assert.match(quiet, /^## New in this build\n\nNo user-facing changes in this build\.\n\n/)
})

test('a change file with no commit stops the notes', (t) => {
    const { cwd, github } = fixture(t)
    writeFileSync(join(cwd, '.changes/draft.md'), '---\ncategory: changed\n---\nDraft.\n')
    assert.throws(
        () =>
            collectNotes({
                repoRoot: cwd,
                github,
                coAuthors: classified,
                unknownCoAuthors: 'skip',
                warn: () => {},
            }),
        /\.changes\/draft\.md has no commit after v1\.0\.0/
    )
})

test('a change file created by a direct push gets no link and a warning', (t) => {
    const { cwd, github } = fixture(t)
    writeFileSync(join(cwd, '.changes/direct.md'), '---\ncategory: changed\n---\nDirect.\n')
    git(cwd, ['add', '-A'])
    git(cwd, ['commit', '-q', '-m', 'direct push'])
    const sha = git(cwd, ['rev-parse', 'HEAD'])
    const warnings: string[] = []
    const notes = collectNotes({
        repoRoot: cwd,
        github: {
            commits: (wanted) => {
                const known = github.commits(wanted.filter((item) => item !== sha))
                return known.set(sha, { pr: null, authors: [maintainer] })
            },
            pulls: github.pulls,
        },
        coAuthors: classified,
        unknownCoAuthors: 'fail',
        warn: (message) => warnings.push(message),
    })
    assert.deepEqual(warnings, [
        `.changes/direct.md: commit ${sha.slice(0, 8)} has no pull request`,
    ])
    assert.match(renderRelease(notes), /^- Direct\.$/m)
})

test('change files parse their header and reject malformed ones', () => {
    assert.deepEqual(
        parseChange(
            'a.md',
            '---\r\ncategory: security\r\nprs: [4, 12]\r\n---\r\nFixed a\r\nhole.\r\n'
        ),
        { file: 'a.md', category: 'security', text: 'Fixed a hole.', prs: [4, 12], thanks: [] }
    )
    const rejects = (source: string, pattern: RegExp) =>
        assert.throws(() => parseChange('a.md', source), pattern)
    rejects('Added X.\n', /header between two --- lines/)
    rejects('---\ncategory: new\n---\nX.\n', /category must be one of/)
    rejects('---\ncategory: toString\n---\nX.\n', /category must be one of/)
    rejects('---\nprs: [1]\n---\nX.\n', /category must be one of/)
    rejects('---\ncategory: added\nauthor: me\n---\nX.\n', /unknown header key author/)
    rejects('---\ncategory: added\ncategory: fixed\n---\nX.\n', /appears twice/)
    rejects('---\ncategory: added\n---\n\n', /text is empty/)
    rejects('---\ncategory: added\n---\nOne.\n\nTwo.\n', /one paragraph/)
    rejects('---\ncategory: added\n---\n- Added X.\n', /without a list marker/)
    rejects('---\ncategory: added\nprs: 12\n---\nX.\n', /prs must be a list/)
    rejects('---\ncategory: added\nprs: [#12]\n---\nX.\n', /#12 in prs is not a PR number/)
    rejects('---\ncategory: added\nprs: [1,]\n---\nX.\n', /prs has an empty item/)
    rejects(
        '---\ncategory: added\nthanks: [@-bad]\n---\nX.\n',
        /@-bad in thanks is not a GitHub login/
    )
})

test('co-authors.json holds lowercase emails classified once', () => {
    assert.deepEqual(parseCoAuthors('{"people":["a@b.c"],"bots":[]}'), {
        people: new Set(['a@b.c']),
        bots: new Set(),
    })
    const rejects = (source: string, pattern: RegExp) =>
        assert.throws(() => parseCoAuthors(source), pattern)
    rejects('[]', /must hold an object/)
    rejects('{"people":[]}', /exactly the keys people and bots/)
    rejects('{"people":["A@b.c"],"bots":[]}', /A@b\.c in people is not a lowercase email/)
    rejects('{"people":["a@b.c","a@b.c"],"bots":[]}', /appears twice/)
    rejects('{"people":["a@b.c"],"bots":["a@b.c"]}', /a@b\.c as both/)
})
