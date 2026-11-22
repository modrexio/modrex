import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const CONFIG_FILE = 'lexmit.config.json'

type LexmitConfig = {
    historyBaseline: string
    localeDir: string
    readme: string
    statusAssetDir: string
    contributorsFile: string
    translationGuide: string
}

const CONFIG_KEYS = [
    'historyBaseline',
    'localeDir',
    'readme',
    'statusAssetDir',
    'contributorsFile',
    'translationGuide',
] as const

// The config sits at the Git repository root, so the commands work from any directory below it.
function findRepositoryRoot(start: string) {
    let dir = resolve(start)
    while (!existsSync(join(dir, CONFIG_FILE))) {
        const parent = dirname(dir)
        if (parent === dir) {
            throw new Error(`${CONFIG_FILE} was not found in ${start} or any parent directory`)
        }
        dir = parent
    }
    return dir
}

// Every path is compared as a Git path, against git show and git diff output, so it has to be
// repository relative with forward slashes and no dot segments, or nothing would ever match it.
function parseRepositoryPath(key: string, value: unknown) {
    if (typeof value !== 'string' || value === '') {
        throw new Error(`${CONFIG_FILE}: ${key} must be a non-empty string`)
    }
    const segments = value.split('/')
    if (
        value.includes('\\') ||
        value.startsWith('/') ||
        /^[A-Za-z]:/u.test(value) ||
        segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
        throw new Error(
            `${CONFIG_FILE}: ${key} must be a repository relative path with forward slashes, got ${JSON.stringify(value)}`
        )
    }
    return value
}

// Acceptance reconstruction starts at the audited baseline. Pre-baseline events create no
// review debt. Rewriting repository history requires a new audit, never a guessed baseline,
// so only a full commit id is accepted.
function parseBaseline(value: unknown) {
    if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) {
        throw new Error(`${CONFIG_FILE}: historyBaseline must be a full 40 character commit id`)
    }
    return value
}

export function parseConfig(text: string): LexmitConfig {
    const raw: unknown = JSON.parse(text)
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error(`${CONFIG_FILE} must hold a JSON object`)
    }
    const unknownKeys = Object.keys(raw).filter(
        (key) => !(CONFIG_KEYS as readonly string[]).includes(key)
    )
    if (unknownKeys.length > 0) {
        throw new Error(`${CONFIG_FILE}: unknown key(s) ${unknownKeys.join(', ')}`)
    }
    const fields = raw as Record<string, unknown>
    return {
        historyBaseline: parseBaseline(fields.historyBaseline),
        localeDir: parseRepositoryPath('localeDir', fields.localeDir),
        readme: parseRepositoryPath('readme', fields.readme),
        statusAssetDir: parseRepositoryPath('statusAssetDir', fields.statusAssetDir),
        contributorsFile: parseRepositoryPath('contributorsFile', fields.contributorsFile),
        translationGuide: parseRepositoryPath('translationGuide', fields.translationGuide),
    }
}

export const REPOSITORY_ROOT = findRepositoryRoot(process.cwd())

const config = parseConfig(readFileSync(join(REPOSITORY_ROOT, CONFIG_FILE), 'utf8'))

export const I18N_HISTORY_BASELINE = config.historyBaseline
export const I18N_LOCALE_DIR = config.localeDir
export const I18N_DIR = resolve(REPOSITORY_ROOT, config.localeDir)
export const README_PATH = config.readme
export const STATUS_ASSET_DIR = config.statusAssetDir
export const CONTRIBUTORS_PATH = config.contributorsFile
export const TRANSLATION_GUIDE_PATH = config.translationGuide
