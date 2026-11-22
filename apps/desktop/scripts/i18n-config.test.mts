import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { CONFIG_FILE, parseConfig, REPOSITORY_ROOT } from './i18n-config.mts'

const VALID = {
    historyBaseline: 'da1040c9f04d7e004d5cd1fee3af15fabaa80b7e',
    localeDir: 'apps/desktop/src/renderer/src/i18n',
    readme: 'README.md',
    statusAssetDir: 'assets/i18n/status',
    contributorsFile: 'apps/desktop/translation-contributors.generated.json',
    translationGuide: 'docs/contributing/translating.md',
}

function parseWith(overrides: Record<string, unknown>) {
    return () => parseConfig(JSON.stringify({ ...VALID, ...overrides }))
}

test('the repository config is found above the working directory and parses', () => {
    assert.ok(existsSync(join(REPOSITORY_ROOT, '.git')))
    const config = parseConfig(readFileSync(join(REPOSITORY_ROOT, CONFIG_FILE), 'utf8'))
    assert.ok(existsSync(join(REPOSITORY_ROOT, config.localeDir, 'en.json')))
    assert.ok(existsSync(join(REPOSITORY_ROOT, config.readme)))
    assert.ok(existsSync(join(REPOSITORY_ROOT, config.contributorsFile)))
    assert.ok(existsSync(join(REPOSITORY_ROOT, config.translationGuide)))
})

test('config accepts repository relative paths and a full commit id', () => {
    assert.deepEqual(parseConfig(JSON.stringify(VALID)), VALID)
})

test('config rejects unknown and missing keys', () => {
    assert.throws(parseWith({ localDir: 'i18n' }), /unknown key\(s\) localDir/u)
    assert.throws(parseWith({ readme: undefined }), /readme must be/u)
    assert.throws(() => parseConfig('[]'), /must hold a JSON object/u)
})

test('config rejects paths Git would never report', () => {
    for (const localeDir of [
        '',
        '/abs/i18n',
        'C:/i18n',
        'apps\\i18n',
        './i18n',
        'apps/../i18n',
        'apps/i18n/',
        'apps//i18n',
    ]) {
        assert.throws(parseWith({ localeDir }), /localeDir must be/u, JSON.stringify(localeDir))
    }
})

test('config rejects an abbreviated or symbolic history baseline', () => {
    for (const historyBaseline of [
        'da1040c9',
        'HEAD',
        'DA1040C9F04D7E004D5CD1FEE3AF15FABAA80B7E',
    ]) {
        assert.throws(parseWith({ historyBaseline }), /historyBaseline must be a full/u)
    }
})
