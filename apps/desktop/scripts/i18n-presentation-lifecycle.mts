import { errorMessage, type CliIO } from './i18n-io.mts'
import { mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { writeSerializedFileAtomically } from './i18n-files.mts'
import { I18N_DIR, inspectLocales } from './i18n-inspection.mts'
import { buildStatusSummaries } from './i18n-presentation.mts'
import { renderStatusSvg, STATUS_ASSET_DIR } from './i18n-presentation-svg.mts'
import {
    buildTranslationTable,
    readTranslationContributors,
    replaceTranslationTable,
} from './update-i18n-readme.mts'

type PresentationOptions = {
    i18nDir?: string
    readmePath?: string
    statusAssetDir?: string
    contributorsPath?: string
}
type Operation =
    | { type: 'write-readme' | 'delete-asset'; path: string }
    | { type: 'write-asset'; path: string; locale: string }

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_README_PATH = resolve(SCRIPT_DIR, '../../..', 'README.md')

function readIfExists(path: string) {
    try {
        return readFileSync(path, 'utf8')
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
        throw error
    }
}

function classify(current: string | null, expected: string): 'missing' | 'stale' | 'unchanged' {
    if (current === null) return 'missing'
    if (current !== expected) return 'stale'
    return 'unchanged'
}

// Direct-child SVG files in the status directory belong to the lifecycle. Nested directories,
// such as legend/, are outside locale asset discovery.
function listOwnedSvgFilenames(statusAssetDir: string) {
    let entries
    try {
        entries = readdirSync(statusAssetDir, { withFileTypes: true })
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
        throw error
    }
    return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.svg'))
        .map((entry) => entry.name)
}

function comparePaths(a: string, b: string) {
    return a < b ? -1 : a > b ? 1 : 0
}

/** Builds a read-only presentation plan from one shared summary snapshot. */
export function buildI18nPresentationPlan({
    i18nDir = I18N_DIR,
    readmePath = DEFAULT_README_PATH,
    statusAssetDir = STATUS_ASSET_DIR,
    contributorsPath,
}: PresentationOptions = {}) {
    const inspection = inspectLocales(i18nDir)
    const summaries = buildStatusSummaries(inspection)
    const contributors = contributorsPath
        ? readTranslationContributors(contributorsPath)
        : readTranslationContributors()

    const currentReadme = readIfExists(readmePath)
    if (currentReadme === null) {
        throw new Error(`README not found at ${readmePath}`)
    }
    const table = buildTranslationTable(inspection, contributors, summaries)
    const expectedReadme = replaceTranslationTable(currentReadme, table)
    const readme = {
        path: readmePath,
        current: currentReadme,
        expected: expectedReadme,
        status: currentReadme === expectedReadme ? 'unchanged' : 'stale',
    }

    const expectedFilenames = new Set<string>()
    const assets = [summaries.source, ...summaries.targets].map((summary) => {
        const filename = `${summary.locale}.svg`
        expectedFilenames.add(filename)
        const path = resolve(statusAssetDir, filename)
        const expected = renderStatusSvg(summary)
        const current = readIfExists(path)
        return {
            path,
            filename,
            locale: summary.locale,
            kind: summary.kind,
            expected,
            current,
            status: classify(current, expected),
        }
    })

    const obsolete = listOwnedSvgFilenames(statusAssetDir)
        .filter((filename) => !expectedFilenames.has(filename))
        .map((filename) => ({ path: resolve(statusAssetDir, filename), filename }))
        .sort((a, b) => comparePaths(a.path, b.path))

    const operations = [
        ...(readme.status !== 'unchanged'
            ? [{ type: 'write-readme' as const, path: readme.path }]
            : []),
        ...assets
            .filter((asset) => asset.status !== 'unchanged')
            .map((asset) => ({
                type: 'write-asset' as const,
                path: asset.path,
                locale: asset.locale,
            })),
        ...obsolete.map((item) => ({ type: 'delete-asset' as const, path: item.path })),
    ].sort((a, b) => comparePaths(a.path, b.path))

    return {
        summaries,
        readme,
        assets,
        statusAssetDir,
        obsolete,
        operations,
        clean: operations.length === 0,
    }
}

/** Applies a validated presentation plan in deterministic path order without replanning. */
export function applyI18nPresentationPlan(plan: ReturnType<typeof buildI18nPresentationPlan>) {
    const written = []
    const deleted = []
    if (plan.operations.some((operation) => operation.type === 'write-asset')) {
        mkdirSync(plan.statusAssetDir, { recursive: true })
    }
    for (const operation of plan.operations) {
        if (operation.type === 'write-readme') {
            if (writeSerializedFileAtomically(plan.readme.path, plan.readme.expected)) {
                written.push(operation.path)
            }
            continue
        }
        if (operation.type === 'write-asset') {
            const asset = plan.assets.find((item) => item.path === operation.path)!
            if (writeSerializedFileAtomically(asset.path, asset.expected)) {
                written.push(operation.path)
            }
            continue
        }
        unlinkSync(operation.path)
        deleted.push(operation.path)
    }
    return { written, deleted }
}

function describeDrift(plan: ReturnType<typeof buildI18nPresentationPlan>, operation: Operation) {
    if (operation.type === 'write-readme') return 'stale'
    if (operation.type === 'delete-asset') return 'obsolete'
    return plan.assets.find((asset) => asset.path === operation.path)?.status ?? 'stale'
}

export function runI18nPresentationLifecycle(
    args: string[],
    {
        stdout = process.stdout,
        stderr = process.stderr,
        ...options
    }: CliIO & PresentationOptions = {}
) {
    const mode = args.length === 1 ? args[0] : undefined
    if (mode !== '--check' && mode !== '--write') {
        stderr.write('Usage: bun scripts/i18n-presentation-lifecycle.mts --check|--write\n')
        return 2
    }

    let plan
    try {
        plan = buildI18nPresentationPlan(options)
    } catch (error) {
        stderr.write(`i18n: presentation lifecycle planning failed: ${errorMessage(error)}\n`)
        return 1
    }

    if (mode === '--check') {
        if (plan.clean) {
            stdout.write('i18n: presentation lifecycle is current.\n')
            return 0
        }
        for (const operation of plan.operations) {
            stderr.write(
                `i18n: presentation ${describeDrift(plan, operation)}: ${operation.path}\n`
            )
        }
        return 1
    }

    const result = applyI18nPresentationPlan(plan)
    if (result.written.length === 0 && result.deleted.length === 0) {
        stdout.write('i18n: presentation lifecycle is current.\n')
        return 0
    }
    for (const path of result.written) stdout.write(`i18n: wrote ${path}\n`)
    for (const path of result.deleted) stdout.write(`i18n: removed ${path}\n`)
    return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = runI18nPresentationLifecycle(process.argv.slice(2))
}
