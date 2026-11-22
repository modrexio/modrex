import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPOSITORY = 'modrexio/modrex'
const REPOSITORY_URL = `https://github.com/${REPOSITORY}`

// Maintainers take part in nearly every change, so entries credit only other people. The
// thank-you list at the end of the notes still names them.
const MAINTAINERS = ['ShulhaOleh']

export const CHANGES_DIR = '.changes'
const CO_AUTHORS_FILE = `${CHANGES_DIR}/co-authors.json`

// Keep a Changelog headings, in the order the notes print them.
const CATEGORIES = {
    added: 'Added',
    changed: 'Changed',
    deprecated: 'Deprecated',
    removed: 'Removed',
    fixed: 'Fixed',
    security: 'Security',
} as const
export type Category = keyof typeof CATEGORIES

export type Change = {
    file: string
    category: Category
    text: string
    prs: number[]
    thanks: string[]
}

const HEADER_KEYS = ['category', 'prs', 'thanks']
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

/**
 * Parses one change file: a header of key: value lines between --- lines, then the entry text.
 * The text may wrap over several lines but must stay one paragraph, because it becomes one
 * bullet.
 */
export function parseChange(file: string, source: string): Change {
    const match = source.replaceAll('\r\n', '\n').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!match) throw new Error(`${file}: expected a header between two --- lines, then the text`)
    const fields = new Map<string, string>()
    for (const line of match[1]!.split('\n')) {
        const field = line.match(/^(\w+):(.*)$/)
        if (!field) throw new Error(`${file}: header line "${line}" is not key: value`)
        const key = field[1]!
        if (!HEADER_KEYS.includes(key)) {
            throw new Error(
                `${file}: unknown header key ${key}, expected ${HEADER_KEYS.join(', ')}`
            )
        }
        if (fields.has(key)) throw new Error(`${file}: header key ${key} appears twice`)
        fields.set(key, field[2]!.trim())
    }

    const category = fields.get('category')
    if (category === undefined || !Object.hasOwn(CATEGORIES, category)) {
        throw new Error(`${file}: category must be one of ${Object.keys(CATEGORIES).join(', ')}`)
    }
    const text = match[2]!.trim()
    if (!text) throw new Error(`${file}: the entry text is empty`)
    if (/\n\s*\n/.test(text)) throw new Error(`${file}: the entry text must be one paragraph`)
    if (/^[-*+]\s/.test(text)) {
        throw new Error(`${file}: write the entry without a list marker, the notes add it`)
    }

    const prs = parseList(file, 'prs', fields.get('prs')).map((item) => {
        if (!/^[1-9]\d*$/.test(item)) throw new Error(`${file}: ${item} in prs is not a PR number`)
        return Number(item)
    })
    const thanks = parseList(file, 'thanks', fields.get('thanks'))
    for (const name of thanks) {
        if (name.startsWith('@') && !GITHUB_LOGIN.test(name.slice(1))) {
            throw new Error(`${file}: ${name} in thanks is not a GitHub login`)
        }
    }
    return {
        file,
        category: category as Category,
        text: text.replace(/\s*\n\s*/g, ' '),
        prs,
        thanks,
    }
}

function parseList(file: string, key: string, value: string | undefined) {
    if (value === undefined) return []
    const list = value.match(/^\[(.*)\]$/)
    if (!list) throw new Error(`${file}: ${key} must be a list like [a, b]`)
    const items = list[1]!.split(',').map((item) => item.trim())
    if (items.some((item) => !item)) throw new Error(`${file}: ${key} has an empty item`)
    return items
}

/** Reads every change file, reporting all malformed files at once. */
export function readChanges(repoRoot: string) {
    const names = readdirSync(join(repoRoot, CHANGES_DIR))
        .filter((name) => name.endsWith('.md'))
        .sort()
    const changes: Change[] = []
    const errors: string[] = []
    for (const name of names) {
        const file = `${CHANGES_DIR}/${name}`
        try {
            changes.push(parseChange(file, readFileSync(join(repoRoot, file), 'utf8')))
        } catch (error) {
            errors.push((error as Error).message)
        }
    }
    if (errors.length) throw new Error(errors.join('\n'))
    return changes
}

export type CoAuthors = { people: Set<string>; bots: Set<string> }

/**
 * Parses co-authors.json, the owner's record of which co-author emails with no GitHub account
 * belong to a person and which to a bot such as an AI tool.
 */
export function parseCoAuthors(source: string): CoAuthors {
    const value: unknown = JSON.parse(source)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${CO_AUTHORS_FILE} must hold an object with people and bots`)
    }
    const keys = Object.keys(value).sort().join(',')
    if (keys !== 'bots,people') {
        throw new Error(`${CO_AUTHORS_FILE} must hold exactly the keys people and bots`)
    }
    const record = value as Record<string, unknown>
    const people = emailSet('people', record.people)
    const bots = emailSet('bots', record.bots)
    const both = [...people].filter((email) => bots.has(email))
    if (both.length) throw new Error(`${CO_AUTHORS_FILE} lists ${both.join(', ')} as both`)
    return { people, bots }
}

function emailSet(key: string, value: unknown) {
    if (!Array.isArray(value)) throw new Error(`${CO_AUTHORS_FILE}: ${key} must be a list`)
    const emails = new Set<string>()
    for (const email of value) {
        if (typeof email !== 'string' || email !== email.toLowerCase() || !email.includes('@')) {
            throw new Error(
                `${CO_AUTHORS_FILE}: ${String(email)} in ${key} is not a lowercase email`
            )
        }
        if (emails.has(email)) throw new Error(`${CO_AUTHORS_FILE}: ${email} appears twice`)
        emails.add(email)
    }
    return emails
}

export function readCoAuthors(repoRoot: string) {
    return parseCoAuthors(readFileSync(join(repoRoot, CO_AUTHORS_FILE), 'utf8'))
}

/** A git author or Co-authored-by trailer, with the account GitHub matched to its email. */
export type GitActor = { name: string; email: string; login: string | null }
export type CommitInfo = { pr: number | null; authors: GitActor[] }
export type PullInfo = {
    author: { login: string; bot: boolean } | null
    coAuthors: GitActor[]
}
export type GitHub = {
    commits(shas: string[]): Map<string, CommitInfo>
    pulls(numbers: number[]): Map<number, PullInfo>
}

const ACTORS = 'authors(first: 100) { nodes { name email user { login } } }'

type GraphActors = { nodes: { name: string; email: string; user: { login: string } | null }[] }

function actors(graph: GraphActors): GitActor[] {
    return graph.nodes.map((node) => ({
        name: node.name,
        email: node.email,
        login: node.user?.login ?? null,
    }))
}

/** Looks commits and PRs up through the GitHub GraphQL API with the gh CLI. */
export function createGitHub(): GitHub {
    const query = (fields: string[]) => {
        const [owner, name] = REPOSITORY.split('/')
        const body = `query { repository(owner: "${owner}", name: "${name}") { ${fields.join('\n')} } }`
        try {
            const output = execFileSync('gh', ['api', 'graphql', '-f', `query=${body}`], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
            })
            return (JSON.parse(output) as { data: { repository: Record<string, unknown> } }).data
                .repository
        } catch (error) {
            const stderr = (error as { stderr?: string }).stderr?.trim()
            throw new Error(
                `GitHub lookup through gh failed: ${stderr || (error as Error).message}`,
                { cause: error }
            )
        }
    }
    return {
        commits(shas) {
            const result = new Map<string, CommitInfo>()
            if (!shas.length) return result
            const repository = query(
                shas.map(
                    (sha, index) =>
                        `c${index}: object(oid: "${sha}") { ... on Commit { ${ACTORS} associatedPullRequests(first: 10) { nodes { number mergeCommit { oid } } } } }`
                )
            )
            shas.forEach((sha, index) => {
                const commit = repository[`c${index}`] as {
                    authors: GraphActors
                    associatedPullRequests: {
                        nodes: { number: number; mergeCommit: { oid: string } | null }[]
                    }
                } | null
                if (!commit) throw new Error(`Commit ${sha} is not on GitHub, push it first`)
                // A commit also lists the open PRs that contain it. Only the PR it was squash
                // merged from counts.
                const pr = commit.associatedPullRequests.nodes.find(
                    (node) => node.mergeCommit?.oid === sha
                )
                result.set(sha, { pr: pr?.number ?? null, authors: actors(commit.authors) })
            })
            return result
        },
        pulls(numbers) {
            const result = new Map<number, PullInfo>()
            if (!numbers.length) return result
            const repository = query(
                numbers.map(
                    (number) =>
                        `p${number}: pullRequest(number: ${number}) { author { login __typename } mergeCommit { ${ACTORS} } }`
                )
            )
            for (const number of numbers) {
                const pull = repository[`p${number}`] as {
                    author: { login: string; __typename: string } | null
                    mergeCommit: { authors: GraphActors } | null
                }
                result.set(number, {
                    author: pull.author && {
                        login: pull.author.login,
                        bot: pull.author.__typename === 'Bot',
                    },
                    coAuthors: pull.mergeCommit ? actors(pull.mergeCommit.authors) : [],
                })
            }
            return result
        },
    }
}

export type Person = { key: string; name: string; label: string }

export type Entry = {
    change: Change
    commits: string[]
    prs: number[]
    authors: Person[]
}

export type Notes = { base: string; entries: Entry[]; contributors: Person[] }

export type CollectOptions = {
    repoRoot: string
    github: GitHub
    coAuthors: CoAuthors
    // A release stops on a co-author nobody has classified yet. A nightly has nobody to ask,
    // so it leaves the name out and warns.
    unknownCoAuthors: 'fail' | 'skip'
    warn: (message: string) => void
}

/**
 * Gathers the unreleased change files with their PRs and authors, plus everyone who
 * contributed since the last v tag. An entry links the PRs its prs field names, or else the
 * PR that created its file, plus every later PR that edited the file.
 */
export function collectNotes(options: CollectOptions): Notes {
    const { repoRoot, github, coAuthors, warn } = options
    const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
    const lines = (output: string) => (output ? output.split('\n') : [])

    const changes = readChanges(repoRoot)
    const base = git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', 'HEAD')
    const range = lines(git('rev-list', '--reverse', `${base}..HEAD`))
    const position = new Map(range.map((sha, index) => [sha, index]))

    const errors: string[] = []
    const fileCommits = new Map<Change, string[]>()
    for (const change of changes) {
        const commits = lines(
            git('log', '--follow', '--format=%H', `${base}..HEAD`, '--', change.file)
        ).reverse()
        if (!commits.length) errors.push(`${change.file} has no commit after ${base}, commit it`)
        fileCommits.set(change, commits)
    }
    if (errors.length) throw new Error(errors.join('\n'))

    const commitInfo = github.commits(range)
    const prOf = (change: Change, sha: string) => {
        const pr = commitInfo.get(sha)!.pr
        if (pr === null) warn(`${change.file}: commit ${sha.slice(0, 8)} has no pull request`)
        return pr
    }
    const entryPrs = new Map<Change, number[]>()
    for (const change of changes) {
        const [created, ...edits] = fileCommits.get(change)!
        const origin = change.prs.length ? change.prs : [prOf(change, created!)]
        const prs = [...origin, ...edits.map((sha) => prOf(change, sha))]
        entryPrs.set(
            change,
            [...new Set(prs.filter((pr) => pr !== null))].sort((a, b) => a - b)
        )
    }

    const allPrs = new Set([...entryPrs.values()].flat())
    for (const info of commitInfo.values()) if (info.pr !== null) allPrs.add(info.pr)
    const pulls = github.pulls([...allPrs].sort((a, b) => a - b))

    const unknown = new Map<string, GitActor>()
    const actorPerson = (actor: GitActor): Person | null => {
        const email = actor.email.toLowerCase()
        if (actor.name.endsWith('[bot]') || actor.login?.endsWith('[bot]')) return null
        if (coAuthors.bots.has(email)) return null
        if (actor.login) return loginPerson(actor.login)
        if (coAuthors.people.has(email)) {
            return { key: `email:${email}`, name: actor.name, label: escapeMarkdown(actor.name) }
        }
        unknown.set(email, actor)
        return null
    }
    const pullPeople = (number: number) => {
        const pull = pulls.get(number)!
        const people = pull.coAuthors.map(actorPerson)
        if (pull.author && !pull.author.bot) people.unshift(loginPerson(pull.author.login))
        return people.filter((person) => person !== null)
    }

    const maintainers = new Set(MAINTAINERS.map((login) => loginPerson(login).key))
    const entries = changes.map((change) => {
        const prs = entryPrs.get(change)!
        const authors = unique(prs.flatMap(pullPeople)).filter(
            (person) => !maintainers.has(person.key)
        )
        return { change, commits: fileCommits.get(change)!, prs, authors }
    })
    // Files created by one commit, such as several entries written at once, keep the order of
    // the PRs they name.
    const firstPr = (entry: Entry) => entry.prs[0] ?? Number.MAX_SAFE_INTEGER
    entries.sort(
        (a, b) =>
            position.get(a.commits[0]!)! - position.get(b.commits[0]!)! ||
            firstPr(a) - firstPr(b) ||
            a.change.file.localeCompare(b.change.file)
    )

    const contributors = unique(
        range.flatMap((sha) => {
            const info = commitInfo.get(sha)!
            if (info.pr !== null) return pullPeople(info.pr)
            return info.authors.map(actorPerson).filter((person) => person !== null)
        })
    ).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))

    if (unknown.size) {
        const names = [...unknown.values()].map((actor) => `${actor.name} <${actor.email}>`)
        const message = `Co-authors with no GitHub account that ${CO_AUTHORS_FILE} does not list yet:\n${names.map((name) => `  ${name}`).join('\n')}`
        if (options.unknownCoAuthors === 'fail') {
            throw new Error(`${message}\nAdd each email to people or bots there, then run again.`)
        }
        warn(`${message}\nThey are left out of these notes.`)
    }

    return { base, entries, contributors }
}

function loginPerson(login: string): Person {
    return {
        key: `github:${login.toLowerCase()}`,
        name: login,
        label: `[@${login}](https://github.com/${login})`,
    }
}

function unique(people: Person[]) {
    return [...new Map(people.map((person) => [person.key, person])).values()]
}

function escapeMarkdown(text: string) {
    return text.replace(/[\\`*_[\]<>]/g, '\\$&')
}

function entryLine(entry: Entry) {
    const credit: string[] = []
    if (entry.prs.length) {
        const links = entry.prs.map((pr) => `[#${pr}](${REPOSITORY_URL}/pull/${pr})`).join(', ')
        const by = entry.authors.map((person) => person.label).join(', ')
        credit.push(by ? `${links} by ${by}` : links)
    }
    if (entry.change.thanks.length) {
        const names = entry.change.thanks.map((name) =>
            name.startsWith('@') ? loginPerson(name.slice(1)).label : escapeMarkdown(name)
        )
        credit.push(`thanks to ${names.join(', ')}`)
    }
    const text = entry.change.text
    return credit.length ? `- ${text} (${credit.join(', ')})` : `- ${text}`
}

function renderEntries(entries: Entry[]) {
    return (Object.keys(CATEGORIES) as Category[])
        .map((category) => {
            const lines = entries.filter((entry) => entry.change.category === category)
            if (!lines.length) return null
            return `### ${CATEGORIES[category]}\n\n${lines.map(entryLine).join('\n')}`
        })
        .filter((section) => section !== null)
}

function renderContributors(contributors: Person[]) {
    if (!contributors.length) return []
    const names = contributors.map((person) => person.label).join(', ')
    return [`### Contributors\n\nThank you to everyone who contributed to this release: ${names}`]
}

/** The body of a ## X.Y.Z section, which is also the GitHub release body. */
export function renderRelease(notes: Notes) {
    return [...renderEntries(notes.entries), ...renderContributors(notes.contributors)].join('\n\n')
}

/**
 * Nightly notes: the entries whose files changed since the previous nightly's commit, then
 * everything since the last release. One rolling release carries them, so someone who skipped
 * nightlies still needs the full list.
 */
export function renderNightly(notes: Notes, sinceNightly: Set<string>) {
    const fresh = notes.entries.filter((entry) =>
        entry.commits.some((sha) => sinceNightly.has(sha))
    )
    const freshBody = fresh.length
        ? renderEntries(fresh).join('\n\n')
        : 'No user-facing changes in this build.'
    const everything = renderRelease(notes) || 'No user-facing changes since the last release.'
    return `## New in this build\n\n${freshBody}\n\n## Everything since ${notes.base}\n\n${everything}`
}
