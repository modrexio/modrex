import assert from 'node:assert/strict'
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
    applyI18nPresentationPlan,
    buildI18nPresentationPlan,
    runI18nPresentationLifecycle,
} from './i18n-presentation-lifecycle.mjs'
import { deriveTargetStatus } from './i18n-presentation.mjs'
import { renderStatusSvg } from './i18n-presentation-svg.mjs'

const README_FIXTURE =
    '# Fixture\n\n<!-- TRANSLATION_STATUS_START -->\nstale placeholder\n<!-- TRANSLATION_STATUS_END -->\n\nAfter marker text.\n'

function makeFixture({
    locales = { en: { key: 'English' }, de: { key: 'Deutsch' } },
    contributors = { de: ['FixtureUser'] },
    readme = README_FIXTURE,
    withStatusDir = false,
} = {}) {
    const root = mkdtempSync(join(tmpdir(), 'modrex-i18n-lifecycle-'))
    const i18nDir = join(root, 'i18n')
    const statusAssetDir = join(root, 'status')
    const readmePath = join(root, 'README.md')
    const contributorsPath = join(root, 'contributors.json')

    mkdirSync(i18nDir, { recursive: true })
    for (const [id, content] of Object.entries(locales)) {
        writeFileSync(join(i18nDir, `${id}.json`), JSON.stringify(content))
    }
    writeFileSync(readmePath, readme)
    writeFileSync(contributorsPath, JSON.stringify(contributors))
    if (withStatusDir) mkdirSync(statusAssetDir, { recursive: true })

    return {
        root,
        i18nDir,
        statusAssetDir,
        readmePath,
        contributorsPath,
        options: { i18nDir, statusAssetDir, readmePath, contributorsPath },
        cleanup: () => rmSync(root, { recursive: true, force: true }),
    }
}

function withFixture(overrides, callback) {
    const fixture = makeFixture(overrides)
    try {
        return callback(fixture)
    } finally {
        fixture.cleanup()
    }
}

function addLocale(fixture, id, content) {
    writeFileSync(join(fixture.i18nDir, `${id}.json`), JSON.stringify(content))
}

function removeLocale(fixture, id) {
    unlinkSync(join(fixture.i18nDir, `${id}.json`))
}

test('clean baseline: a fully applied fixture reports zero drift and zero operations', () => {
    withFixture({}, (fixture) => {
        const first = buildI18nPresentationPlan(fixture.options)
        applyI18nPresentationPlan(first)
        const second = buildI18nPresentationPlan(fixture.options)
        assert.equal(second.clean, true)
        assert.deepEqual(second.operations, [])
        assert.equal(second.readme.status, 'unchanged')
        for (const asset of second.assets) assert.equal(asset.status, 'unchanged')
        assert.deepEqual(second.obsolete, [])
    })
})

test('stale README: check reports stale, apply corrects it while preserving surrounding bytes', () => {
    withFixture({}, (fixture) => {
        const plan = buildI18nPresentationPlan(fixture.options)
        assert.equal(plan.readme.status, 'stale')
        assert.equal(
            plan.operations.some((operation) => operation.type === 'write-readme'),
            true
        )

        const check = { value: '' }
        const checkStream = { write: (chunk) => (check.value += chunk) }
        const checkStatus = runI18nPresentationLifecycle(['--check'], {
            stdout: checkStream,
            stderr: checkStream,
            ...fixture.options,
        })
        assert.equal(checkStatus, 1)
        assert.equal(readFileSync(fixture.readmePath, 'utf8'), README_FIXTURE)

        applyI18nPresentationPlan(plan)
        const updated = readFileSync(fixture.readmePath, 'utf8')
        assert.equal(updated, plan.readme.expected)
        assert.match(updated, /^# Fixture\n\n<!-- TRANSLATION_STATUS_START -->/u)
        assert.match(updated, /After marker text\.\n$/u)
        assert.doesNotMatch(updated, /stale placeholder/u)
    })
})

test('missing status SVG: check reports missing, apply creates exact expected bytes', () => {
    withFixture({}, (fixture) => {
        const initial = buildI18nPresentationPlan(fixture.options)
        applyI18nPresentationPlan(initial)
        unlinkSync(join(fixture.statusAssetDir, 'de.svg'))

        const plan = buildI18nPresentationPlan(fixture.options)
        const deAsset = plan.assets.find((asset) => asset.locale === 'de')
        assert.equal(deAsset.status, 'missing')

        applyI18nPresentationPlan(plan)
        assert.equal(readFileSync(deAsset.path, 'utf8'), deAsset.expected)
    })
})

test('stale status SVG: check reports stale, apply restores canonical bytes', () => {
    withFixture({}, (fixture) => {
        const initial = buildI18nPresentationPlan(fixture.options)
        applyI18nPresentationPlan(initial)
        const enPath = join(fixture.statusAssetDir, 'en.svg')
        writeFileSync(enPath, 'not a real svg')

        const plan = buildI18nPresentationPlan(fixture.options)
        const enAsset = plan.assets.find((asset) => asset.locale === 'en')
        assert.equal(enAsset.status, 'stale')

        applyI18nPresentationPlan(plan)
        assert.equal(readFileSync(enPath, 'utf8'), enAsset.expected)
    })
})

test('obsolete locale SVG: a previously generated but now-removed locale asset is detected and removed', () => {
    withFixture({}, (fixture) => {
        const initial = buildI18nPresentationPlan(fixture.options)
        applyI18nPresentationPlan(initial)
        const obsoletePath = join(fixture.statusAssetDir, 'fr.svg')
        writeFileSync(obsoletePath, renderStatusSvg({ kind: 'source', locale: 'fr', total: 1 }))

        const plan = buildI18nPresentationPlan(fixture.options)
        assert.deepEqual(
            plan.obsolete.map((item) => item.filename),
            ['fr.svg']
        )
        assert.equal(
            plan.operations.some(
                (operation) => operation.type === 'delete-asset' && operation.path === obsoletePath
            ),
            true
        )

        applyI18nPresentationPlan(plan)
        assert.throws(() => readFileSync(obsoletePath, 'utf8'))
    })
})

test('unknown file preservation: a non-owned neighboring file survives apply byte-identically', () => {
    withFixture({}, (fixture) => {
        const initial = buildI18nPresentationPlan(fixture.options)
        applyI18nPresentationPlan(initial)
        const notesPath = join(fixture.statusAssetDir, 'notes.txt')
        writeFileSync(notesPath, 'do not touch me')

        const plan = buildI18nPresentationPlan(fixture.options)
        assert.deepEqual(plan.obsolete, [])

        applyI18nPresentationPlan(plan)
        assert.equal(readFileSync(notesPath, 'utf8'), 'do not touch me')
    })
})

test('top-level status SVGs outside the expected locale set are obsolete regardless of filename shape', () => {
    withFixture({}, (fixture) => {
        const initial = buildI18nPresentationPlan(fixture.options)
        applyI18nPresentationPlan(initial)
        const customPath = join(fixture.statusAssetDir, 'custom.svg')
        const distinctiveBytes = '<svg data-fixture="distinctive-custom-payload"></svg>\n'
        writeFileSync(customPath, distinctiveBytes)

        const plan = buildI18nPresentationPlan(fixture.options)
        assert.deepEqual(
            plan.obsolete.map((item) => item.filename),
            ['custom.svg']
        )
        assert.equal(
            plan.operations.some(
                (operation) => operation.type === 'delete-asset' && operation.path === customPath
            ),
            true
        )

        const checkOutput = { value: '' }
        const checkStream = { write: (chunk) => (checkOutput.value += chunk) }
        const checkStatus = runI18nPresentationLifecycle(['--check'], {
            stdout: checkStream,
            stderr: checkStream,
            ...fixture.options,
        })
        assert.equal(checkStatus, 1)
        assert.match(checkOutput.value, /obsolete.*custom\.svg/u)
        assert.equal(
            readFileSync(customPath, 'utf8'),
            distinctiveBytes,
            'check mode must not delete'
        )

        applyI18nPresentationPlan(plan)
        assert.throws(() => readFileSync(customPath, 'utf8'))
    })
})

test('legend directory is never swept: real swatches and an unrelated extra file inside legend/ both survive apply untouched', () => {
    withFixture({}, (fixture) => {
        const legendDir = join(fixture.statusAssetDir, 'legend')
        mkdirSync(legendDir, { recursive: true })
        const legendFiles = {
            'accepted.svg': '<svg data-fixture="legend-accepted"></svg>\n',
            'review.svg': '<svg data-fixture="legend-review"></svg>\n',
            'missing.svg': '<svg data-fixture="legend-missing"></svg>\n',
            'extra.svg': '<svg data-fixture="legend-unrelated-extra"></svg>\n',
        }
        for (const [name, bytes] of Object.entries(legendFiles)) {
            writeFileSync(join(legendDir, name), bytes)
        }

        const plan = buildI18nPresentationPlan(fixture.options)
        assert.deepEqual(plan.obsolete, [])
        assert.equal(
            plan.operations.some((operation) => operation.path.includes('legend')),
            false
        )

        applyI18nPresentationPlan(plan)
        for (const [name, bytes] of Object.entries(legendFiles)) {
            assert.equal(readFileSync(join(legendDir, name), 'utf8'), bytes)
        }
    })
})

test('obsolete scanning is non-recursive and never attempts to delete a directory', () => {
    withFixture({}, (fixture) => {
        mkdirSync(join(fixture.statusAssetDir, 'legend'), { recursive: true })
        writeFileSync(join(fixture.statusAssetDir, 'legend', 'nested.svg'), 'nested bytes')

        const plan = buildI18nPresentationPlan(fixture.options)
        assert.deepEqual(plan.obsolete, [])
        assert.doesNotThrow(() => applyI18nPresentationPlan(plan))
        assert.equal(
            readFileSync(join(fixture.statusAssetDir, 'legend', 'nested.svg'), 'utf8'),
            'nested bytes'
        )
    })
})

test('unchanged file preservation: already-current files are not rewritten and keep their mtime', () => {
    withFixture({}, (fixture) => {
        const initial = buildI18nPresentationPlan(fixture.options)
        applyI18nPresentationPlan(initial)
        const enPath = join(fixture.statusAssetDir, 'en.svg')
        const before = statSync(enPath).mtimeMs

        const plan = buildI18nPresentationPlan(fixture.options)
        const result = applyI18nPresentationPlan(plan)
        assert.deepEqual(result.written, [])
        assert.deepEqual(result.deleted, [])
        assert.equal(statSync(enPath).mtimeMs, before)
        assert.equal(
            readFileSync(enPath, 'utf8'),
            plan.assets.find((a) => a.locale === 'en').expected
        )
    })
})

test('full preflight: a stale asset stays untouched when planning later fails on malformed README markers', () => {
    withFixture({}, (fixture) => {
        const initial = buildI18nPresentationPlan(fixture.options)
        applyI18nPresentationPlan(initial)
        const enPath = join(fixture.statusAssetDir, 'en.svg')
        writeFileSync(enPath, 'corrupted before failure')
        const beforeBytes = readFileSync(enPath, 'utf8')

        writeFileSync(fixture.readmePath, '# No markers at all\n')

        assert.throws(() => buildI18nPresentationPlan(fixture.options))
        assert.equal(readFileSync(enPath, 'utf8'), beforeBytes)
    })
})

test('README marker failure: malformed or missing markers fail planning closed with zero writes', () => {
    for (const brokenReadme of [
        '# No markers\n',
        '<!-- TRANSLATION_STATUS_END -->\nonly end\n',
        '<!-- TRANSLATION_STATUS_START -->\nonly start\n',
    ]) {
        withFixture({ readme: brokenReadme }, (fixture) => {
            assert.throws(() => buildI18nPresentationPlan(fixture.options))
            assert.equal(readFileSync(fixture.readmePath, 'utf8'), brokenReadme)
            assert.throws(() => statSync(join(fixture.statusAssetDir, 'en.svg')))
        })
    }
})

test('path safety: a non-canonical locale filename fails planning instead of producing an unsafe asset path', () => {
    withFixture({ locales: { en: { key: 'English' }, DE: { key: 'Bad casing' } } }, (fixture) => {
        assert.throws(() => buildI18nPresentationPlan(fixture.options), /canonical casing/u)
    })
})

test('deterministic plan: locale file creation order does not change expected bytes or operation order', () => {
    const forward = makeFixture({
        locales: { en: { key: 'English' }, de: { key: 'Deutsch' }, uk: { key: 'Ukr' } },
        contributors: { de: ['FixtureUser'], uk: ['FixtureUser'] },
    })
    const backward = makeFixture({
        locales: { uk: { key: 'Ukr' }, de: { key: 'Deutsch' }, en: { key: 'English' } },
        contributors: { uk: ['FixtureUser'], de: ['FixtureUser'] },
    })
    try {
        const planA = buildI18nPresentationPlan(forward.options)
        const planB = buildI18nPresentationPlan(backward.options)
        assert.deepEqual(
            planA.assets.map((asset) => [asset.locale, asset.expected]),
            planB.assets.map((asset) => [asset.locale, asset.expected])
        )
        assert.equal(planA.readme.expected, planB.readme.expected)
        assert.deepEqual(
            planA.operations.map((op) => op.type),
            planB.operations.map((op) => op.type)
        )
    } finally {
        forward.cleanup()
        backward.cleanup()
    }
})

test('same summary snapshot: README and SVG expected bytes derive from the identical summaries', () => {
    withFixture(
        {
            locales: { en: { key: 'English' }, de: { key: 'Deutsch' } },
        },
        (fixture) => {
            const plan = buildI18nPresentationPlan(fixture.options)
            for (const summary of [plan.summaries.source, ...plan.summaries.targets]) {
                const asset = plan.assets.find((item) => item.locale === summary.locale)
                assert.equal(asset.expected, renderStatusSvg(summary))
            }
            const deSummary = plan.summaries.targets.find((s) => s.locale === 'de')
            const status = deriveTargetStatus(deSummary)
            assert.match(plan.readme.expected, new RegExp(`de\\.svg[^\\n]*> ${status.label}`, 'u'))
        }
    )
})

test('check mode performs zero writes and zero deletes even with known drift present', () => {
    withFixture({}, (fixture) => {
        const initial = buildI18nPresentationPlan(fixture.options)
        applyI18nPresentationPlan(initial)
        const enPath = join(fixture.statusAssetDir, 'en.svg')
        writeFileSync(enPath, 'stale bytes')
        const obsoletePath = join(fixture.statusAssetDir, 'fr.svg')
        writeFileSync(obsoletePath, 'obsolete bytes')
        writeFileSync(fixture.readmePath, README_FIXTURE)

        const before = {
            readme: readFileSync(fixture.readmePath, 'utf8'),
            en: readFileSync(enPath, 'utf8'),
            fr: readFileSync(obsoletePath, 'utf8'),
        }

        const output = { value: '' }
        const stream = { write: (chunk) => (output.value += chunk) }
        const status = runI18nPresentationLifecycle(['--check'], {
            stdout: stream,
            stderr: stream,
            ...fixture.options,
        })
        assert.equal(status, 1)
        assert.equal(readFileSync(fixture.readmePath, 'utf8'), before.readme)
        assert.equal(readFileSync(enPath, 'utf8'), before.en)
        assert.equal(readFileSync(obsoletePath, 'utf8'), before.fr)
    })
})

test('idempotent apply: a second apply on a converged fixture writes and deletes nothing', () => {
    withFixture({}, (fixture) => {
        const staleObsoletePath = join(fixture.statusAssetDir, 'fr.svg')
        mkdirSync(fixture.statusAssetDir, { recursive: true })
        writeFileSync(staleObsoletePath, 'obsolete')

        const firstPlan = buildI18nPresentationPlan(fixture.options)
        const firstResult = applyI18nPresentationPlan(firstPlan)
        assert.ok(firstResult.written.length > 0)
        assert.ok(firstResult.deleted.length > 0)

        const secondPlan = buildI18nPresentationPlan(fixture.options)
        assert.equal(secondPlan.clean, true)
        const secondResult = applyI18nPresentationPlan(secondPlan)
        assert.deepEqual(secondResult.written, [])
        assert.deepEqual(secondResult.deleted, [])
    })
})

test('locale addition: a newly added locale gains a deterministic expected SVG without disturbing existing outputs', () => {
    withFixture({}, (fixture) => {
        const initial = buildI18nPresentationPlan(fixture.options)
        applyI18nPresentationPlan(initial)
        const enBefore = readFileSync(join(fixture.statusAssetDir, 'en.svg'), 'utf8')
        const deBefore = readFileSync(join(fixture.statusAssetDir, 'de.svg'), 'utf8')

        addLocale(fixture, 'uk', { key: 'Ukrainian' })
        writeFileSync(
            fixture.contributorsPath,
            JSON.stringify({ de: ['FixtureUser'], uk: ['FixtureUser'] })
        )

        const plan = buildI18nPresentationPlan(fixture.options)
        const ukAsset = plan.assets.find((asset) => asset.locale === 'uk')
        assert.equal(ukAsset.status, 'missing')
        const enAsset = plan.assets.find((asset) => asset.locale === 'en')
        const deAsset = plan.assets.find((asset) => asset.locale === 'de')
        assert.equal(enAsset.status, 'unchanged')
        assert.equal(deAsset.status, 'unchanged')
        assert.equal(enAsset.expected, enBefore)
        assert.equal(deAsset.expected, deBefore)
    })
})

test('locale removal: a removed locale disappears from the expected README row and its old SVG becomes obsolete', () => {
    withFixture(
        {
            locales: { en: { key: 'English' }, de: { key: 'Deutsch' }, uk: { key: 'Ukr' } },
            contributors: { de: ['FixtureUser'], uk: ['FixtureUser'] },
        },
        (fixture) => {
            const initial = buildI18nPresentationPlan(fixture.options)
            applyI18nPresentationPlan(initial)
            assert.match(initial.readme.expected, /uk\.svg/u)

            removeLocale(fixture, 'uk')
            writeFileSync(fixture.contributorsPath, JSON.stringify({ de: ['FixtureUser'] }))

            const plan = buildI18nPresentationPlan(fixture.options)
            assert.doesNotMatch(plan.readme.expected, /uk\.svg/u)
            assert.deepEqual(
                plan.obsolete.map((item) => item.filename),
                ['uk.svg']
            )
        }
    )
})

test('check-then-write convergence: read-only check never mutates and --write only ever needs one pass to converge', () => {
    withFixture({}, (fixture) => {
        const checkOutput = { value: '' }
        const checkStream = { write: (chunk) => (checkOutput.value += chunk) }
        const checkStatus = runI18nPresentationLifecycle(['--check'], {
            stdout: checkStream,
            stderr: checkStream,
            ...fixture.options,
        })
        assert.equal(checkStatus, 1)

        const writeOutput = { value: '' }
        const writeStream = { write: (chunk) => (writeOutput.value += chunk) }
        const writeStatus = runI18nPresentationLifecycle(['--write'], {
            stdout: writeStream,
            stderr: writeStream,
            ...fixture.options,
        })
        assert.equal(writeStatus, 0)

        const secondCheckOutput = { value: '' }
        const secondCheckStream = { write: (chunk) => (secondCheckOutput.value += chunk) }
        const secondCheckStatus = runI18nPresentationLifecycle(['--check'], {
            stdout: secondCheckStream,
            stderr: secondCheckStream,
            ...fixture.options,
        })
        assert.equal(secondCheckStatus, 0)
        assert.match(secondCheckOutput.value, /current/u)
    })
})

test('CLI usage: unsupported arguments fail with exit 2 and do not touch the filesystem', () => {
    withFixture({}, (fixture) => {
        const output = { value: '' }
        const stream = { write: (chunk) => (output.value += chunk) }
        for (const args of [[], ['--bogus'], ['--check', '--write']]) {
            const status = runI18nPresentationLifecycle(args, {
                stdout: stream,
                stderr: stream,
                ...fixture.options,
            })
            assert.equal(status, 2)
        }
        assert.equal(readFileSync(fixture.readmePath, 'utf8'), README_FIXTURE)
    })
})

test('planning failure via CLI reports exit 1 with a descriptive message and no writes', () => {
    withFixture({ readme: '# broken\n' }, (fixture) => {
        const output = { value: '' }
        const stream = { write: (chunk) => (output.value += chunk) }
        const status = runI18nPresentationLifecycle(['--check'], {
            stdout: stream,
            stderr: stream,
            ...fixture.options,
        })
        assert.equal(status, 1)
        assert.match(output.value, /planning failed/u)
        assert.equal(readFileSync(fixture.readmePath, 'utf8'), '# broken\n')
    })
})

test('current real presentation lifecycle is clean on the committed repository', () => {
    const plan = buildI18nPresentationPlan()
    assert.equal(plan.clean, true)
    assert.deepEqual(plan.operations, [])
    assert.deepEqual(plan.obsolete, [])
})

test('the documentation workflow materializes presentation outputs and stages only owned paths', () => {
    const workflow = readFileSync(
        resolve(import.meta.dirname, '../../../.github/workflows/translation-status.yml'),
        'utf8'
    )
    assert.match(workflow, /i18n-presentation-lifecycle\.mjs --write/u)
    assert.doesNotMatch(workflow, /update-i18n-readme\.mjs\s*$/mu)
    assert.doesNotMatch(workflow, /i18n-presentation-lifecycle\.mjs --check/u)

    const contributorsIndex = workflow.indexOf('update-i18n-contributors.mjs')
    const writeIndex = workflow.indexOf('i18n-presentation-lifecycle.mjs --write')
    assert.ok(contributorsIndex >= 0 && writeIndex > contributorsIndex)

    assert.match(
        workflow,
        /git add README\.md apps\/desktop\/translation-contributors\.generated\.json assets\/i18n\/status/u
    )
    assert.doesNotMatch(workflow, /git add \.\s|git add -A/u)
    assert.match(workflow, /git diff --cached --quiet/u)
    assert.match(workflow, /docs: update translation status/u)
})
