import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { inspectLocales, isUntranslatedValue } from './check-i18n.mjs'

const PER_PAGE = 100
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const CONTRIBUTORS_PATH = resolve(SCRIPT_DIR, '..', 'translation-contributors.generated.json')
const LOCALE_PATH = 'apps/desktop/src/renderer/src/i18n'

function readLocaleAtRevision(revision, localeId) {
    const path = `${LOCALE_PATH}/${localeId}.json`
    let listed
    try {
        listed = execFileSync('git', ['ls-tree', '-r', '--name-only', revision, '--', path], {
            encoding: 'utf8',
        })
    } catch (error) {
        throw new Error(`Could not inspect Git revision '${revision}'`, { cause: error })
    }
    if (listed.trim().length === 0) return undefined
    return execFileSync('git', ['show', `${revision}:${path}`], { encoding: 'utf8' })
}

function translatedLocaleContent(value) {
    if (typeof value === 'string') return isUntranslatedValue(value) ? undefined : value
    if (Array.isArray(value) || value === null || typeof value !== 'object') return value

    const entries = Object.entries(value)
        .map(([key, child]) => [key, translatedLocaleContent(child)])
        .filter(([, child]) => child !== undefined)
    return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

export function localeJsonChanged(previous, current, localeId) {
    try {
        const previousBundle = previous === undefined ? {} : JSON.parse(previous)
        return !isDeepStrictEqual(
            translatedLocaleContent(previousBundle),
            translatedLocaleContent(JSON.parse(current))
        )
    } catch (error) {
        throw new Error(`Could not compare historical JSON for locale '${localeId}'`, {
            cause: error,
        })
    }
}

function commitChangesLocaleJson(localeId, commit) {
    const current = readLocaleAtRevision(commit.sha, localeId)
    if (current === undefined) return false
    const parent = commit.parents[0]?.sha
    const previous = parent ? readLocaleAtRevision(parent, localeId) : undefined
    return localeJsonChanged(previous, current, localeId)
}

export async function collectTranslationContributors(
    localeIds,
    fetchCommits,
    changesLocaleJson = commitChangesLocaleJson
) {
    const contributors = {}

    for (const localeId of localeIds) {
        const usernames = new Set()
        for (let page = 1; ; page += 1) {
            const commits = await fetchCommits(localeId, page)
            if (!Array.isArray(commits)) {
                throw new Error(`GitHub returned invalid commit data for locale '${localeId}'`)
            }

            for (const commit of commits) {
                if (typeof commit?.sha !== 'string' || !Array.isArray(commit.parents)) {
                    throw new Error(`GitHub returned an invalid commit for locale '${localeId}'`)
                }
                if (commit.parents.length > 1) continue
                if (commit.author?.type !== 'User') continue
                const username = commit.author.login
                if (await changesLocaleJson(localeId, commit)) usernames.add(username)
            }

            if (commits.length < PER_PAGE) break
        }

        if (usernames.size > 0) contributors[localeId] = [...usernames].sort()
    }

    return contributors
}

async function fetchGitHubCommits(repository, token, localeId, page) {
    const url = new URL(`https://api.github.com/repos/${repository}/commits`)
    url.searchParams.set('path', `${LOCALE_PATH}/${localeId}.json`)
    url.searchParams.set('per_page', String(PER_PAGE))
    url.searchParams.set('page', String(page))

    const response = await fetch(url, {
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
        },
    })
    if (!response.ok) {
        throw new Error(`GitHub commit request failed with status ${response.status}`)
    }
    return response.json()
}

async function updateTranslationContributors() {
    const repository = process.env.GITHUB_REPOSITORY
    const token = process.env.GITHUB_TOKEN
    if (!repository || !token) {
        throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required')
    }

    const inspection = inspectLocales()
    if (inspection.errors.length > 0) {
        throw new Error(
            `Cannot update translation contributors with invalid locales:\n${inspection.errors.join('\n')}`
        )
    }

    const localeIds = inspection.locales.map((locale) => locale.id)
    const contributors = await collectTranslationContributors(localeIds, (localeId, page) =>
        fetchGitHubCommits(repository, token, localeId, page)
    )
    writeFileSync(CONTRIBUTORS_PATH, `${JSON.stringify(contributors, null, 4)}\n`)
    process.stdout.write('update-i18n-contributors: updated contributor metadata\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    updateTranslationContributors().catch((error) => {
        process.stderr.write(`update-i18n-contributors: ${error.message}\n`)
        process.exitCode = 1
    })
}
