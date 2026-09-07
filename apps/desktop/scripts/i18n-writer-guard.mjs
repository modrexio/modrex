import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TARGET_VALUE_KIND } from '../src/shared/i18n-values.js'
import { createGitAdapter } from './i18n-git.mjs'
import { I18N_LOCALE_DIR, snapshotFromBundles } from './i18n-history.mjs'

// The translation-status workflow may write derived output and nothing else. It runs on main
// with write access, so "it only meant to touch markers" is not good enough: this compares the
// tree it is about to commit against the commit it started from and refuses anything the bot
// is not allowed to have done. Every rule here is about what changed, never about who changed
// it, so a machine identity is never evidence of anything.

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const SOURCE_LOCALE = 'en'
const README_PATH = 'README.md'
const CONTRIBUTORS_PATH = 'apps/desktop/translation-contributors.generated.json'
const STATUS_ASSET_DIR = 'assets/i18n/status'

const README_START = '<!-- TRANSLATION_STATUS_START -->'
const README_END = '<!-- TRANSLATION_STATUS_END -->'

function normalizePath(path) {
    return path.replaceAll('\\', '/')
}

export function classifyWriterPath(path, localeDir = I18N_LOCALE_DIR) {
    const normalized = normalizePath(path)
    if (normalized === README_PATH) return 'readme'
    if (normalized === CONTRIBUTORS_PATH) return 'contributors'

    if (normalized.startsWith(`${localeDir}/`)) {
        const rest = normalized.slice(localeDir.length + 1)
        if (!rest.endsWith('.json') || rest.includes('/')) return undefined
        return rest === `${SOURCE_LOCALE}.json` ? undefined : 'locale'
    }

    // Direct children only. assets/i18n/status/legend/ is hand-maintained, not generated.
    if (normalized.startsWith(`${STATUS_ASSET_DIR}/`)) {
        const rest = normalized.slice(STATUS_ASSET_DIR.length + 1)
        if (!rest.endsWith('.svg') || rest.includes('/')) return undefined
        return 'status-asset'
    }
    return undefined
}

export function checkChangedPaths(paths, localeDir = I18N_LOCALE_DIR) {
    const errors = []
    const locales = []
    for (const path of paths) {
        const kind = classifyWriterPath(path, localeDir)
        if (!kind) {
            errors.push(`'${normalizePath(path)}' is not a path the writer may change`)
            continue
        }
        if (kind === 'locale') locales.push(normalizePath(path))
    }
    return { errors, locales }
}

function describe(value) {
    if (!value || value.kind === TARGET_VALUE_KIND.ABSENT) return 'absent'
    if (value.kind === TARGET_VALUE_KIND.UNTRANSLATED_SCAFFOLD) return 'scaffold'
    return value.kind
}

function translatedText(value) {
    if (value?.kind === TARGET_VALUE_KIND.ACCEPTED) return value.targetText
    if (value?.kind === TARGET_VALUE_KIND.PENDING) return value.targetText
    return undefined
}

// The bot may add or remove a '? ' marker and rewrite an English scaffold. It may never create,
// edit or delete translated text, and it may never turn an English scaffold into a translation:
// that would hand mechanical work the credit for a translation nobody wrote.
export function checkLocalePayloads(localeId, before, after) {
    const errors = []
    const keys = new Set([...before.keys(), ...after.keys()])
    for (const key of [...keys].sort()) {
        const from = before.get(key)
        const to = after.get(key)
        const fromText = translatedText(from)
        const toText = translatedText(to)

        if (fromText !== undefined && toText === undefined) {
            errors.push(`'${localeId}' key '${key}': translated text removed`)
            continue
        }
        if (fromText === undefined && toText !== undefined) {
            errors.push(
                `'${localeId}' key '${key}': ${describe(from)} became a translation (${describe(to)})`
            )
            continue
        }
        if (fromText !== undefined && fromText !== toText) {
            errors.push(`'${localeId}' key '${key}': translated text rewritten`)
        }
    }
    return errors
}

function generatedBlock(text, label) {
    const start = text.indexOf(README_START)
    const end = text.indexOf(README_END)
    if (start === -1 || end === -1 || end < start) {
        throw new Error(`${label} does not contain one generated translation block`)
    }
    return { before: text.slice(0, start), after: text.slice(end + README_END.length) }
}

export function checkReadmeProse(before, after) {
    const from = generatedBlock(before, 'the base README')
    const to = generatedBlock(after, 'the generated README')
    const errors = []
    if (from.before !== to.before) errors.push('README prose before the generated block changed')
    if (from.after !== to.after) errors.push('README prose after the generated block changed')
    return errors
}

function localeTargets(text, localeId, label) {
    const snapshot = snapshotFromBundles(label, { [localeId]: JSON.parse(text) })
    return snapshot.locales.get(localeId).targets
}

function readAt(git, revision, path) {
    const blobs = git.treeBlobs(revision, path)
    const id = blobs.get(normalizePath(path))
    if (id === undefined) return undefined
    return git.readBlobs([id]).get(id)
}

function readWorking(cwd, path) {
    try {
        return readFileSync(join(cwd, path), 'utf8')
    } catch (error) {
        if (error.code === 'ENOENT') return undefined
        throw error
    }
}

export function checkWriterOutput({
    base,
    cwd = REPOSITORY_ROOT,
    localeDir = I18N_LOCALE_DIR,
    git = createGitAdapter({ cwd }),
} = {}) {
    if (!base) throw new Error('A base revision is required')
    const changed = git.changedPathsSince(base)
    const { errors, locales } = checkChangedPaths(changed, localeDir)

    for (const path of locales) {
        const localeId = normalizePath(path).slice(localeDir.length + 1, -'.json'.length)
        const baseText = readAt(git, base, path)
        const currentText = readWorking(cwd, path)
        if (currentText === undefined) {
            errors.push(`'${localeId}' locale file was deleted`)
            continue
        }
        if (baseText === undefined) {
            errors.push(`'${localeId}' is a new locale file; the writer may not create languages`)
            continue
        }
        errors.push(
            ...checkLocalePayloads(
                localeId,
                localeTargets(baseText, localeId, `${localeId}@${base}`),
                localeTargets(currentText, localeId, `${localeId}@working`)
            )
        )
    }

    if (changed.some((path) => normalizePath(path) === README_PATH)) {
        const baseText = readAt(git, base, README_PATH)
        const currentText = readWorking(cwd, README_PATH)
        if (baseText === undefined || currentText === undefined) {
            errors.push('README.md is missing from the base revision or the working tree')
        } else {
            errors.push(...checkReadmeProse(baseText, currentText))
        }
    }

    return { pass: errors.length === 0, errors, changed, locales }
}

export function runI18nWriterGuard(
    args,
    { stdout = process.stdout, stderr = process.stderr, ...options } = {}
) {
    if (args.length !== 1) {
        stderr.write('Usage: node scripts/i18n-writer-guard.mjs <base-revision>\n')
        return 2
    }
    try {
        const result = checkWriterOutput({ ...options, base: args[0] })
        if (!result.pass) {
            stderr.write(
                ['i18n: the generated tree is not allowed writer output:', ...result.errors]
                    .map((line, index) => (index === 0 ? line : `  ${line}`))
                    .join('\n') + '\n'
            )
            return 1
        }
        stdout.write(
            `i18n: writer output verified (${result.changed.length} changed path(s), ` +
                `${result.locales.length} locale file(s), target payloads unchanged).\n`
        )
        return 0
    } catch (error) {
        stderr.write(`i18n: writer guard: ${error.message}\n`)
        return 1
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = runI18nWriterGuard(process.argv.slice(2))
}
