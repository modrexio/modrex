import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import {
    serializeLocale,
    writeLocaleAtomically,
    writeSerializedFileAtomically,
} from './i18n-files.mts'

function fixture(t: TestContext) {
    const directory = fs.mkdtempSync(join(tmpdir(), 'modrex-i18n-files-'))
    t.after(() => {
        t.mock.restoreAll()
        syncBuiltinESMExports()
        fs.rmSync(directory, { recursive: true, force: true })
    })
    return { directory, path: join(directory, 'de.json') }
}

test('locale serialization preserves nested values and ends with one newline', () => {
    assert.equal(
        serializeLocale({ group: { value: '? Grüße\n' }, empty: '' }),
        '{\n    "group": {\n        "value": "? Grüße\\n"\n    },\n    "empty": ""\n}\n'
    )
})

test('atomic writer creates, skips identical bytes, and replaces without temporary files', (t) => {
    const { directory, path } = fixture(t)
    assert.equal(writeLocaleAtomically(path, { key: 'Hallo' }), true)
    const before = fs.statSync(path)
    assert.equal(writeLocaleAtomically(path, { key: 'Hallo' }), false)
    assert.equal(fs.statSync(path).mtimeMs, before.mtimeMs)
    assert.equal(writeLocaleAtomically(path, { key: '? Grüß dich' }), true)
    assert.equal(fs.readFileSync(path, 'utf8'), serializeLocale({ key: '? Grüß dich' }))
    assert.deepEqual(fs.readdirSync(directory), ['de.json'])
})

test('failed replacement preserves the destination and removes the temporary file', (t) => {
    const { directory, path } = fixture(t)
    fs.writeFileSync(path, 'original')
    const failure = new Error('rename denied')
    t.mock.method(fs, 'renameSync', () => {
        throw failure
    })
    syncBuiltinESMExports()
    assert.throws(
        () => writeSerializedFileAtomically(path, 'replacement'),
        (error: Error) => {
            assert.match(error.message, /Failed to replace locale file/)
            assert.equal(error.cause, failure)
            return true
        }
    )
    assert.equal(fs.readFileSync(path, 'utf8'), 'original')
    assert.deepEqual(fs.readdirSync(directory), ['de.json'])
})

test('failed cleanup retains both errors and identifies the recoverable temporary file', (t) => {
    const { directory, path } = fixture(t)
    fs.writeFileSync(path, 'original')
    const replacementError = new Error('rename denied')
    const cleanupError = new Error('cleanup denied')
    t.mock.method(fs, 'renameSync', () => {
        throw replacementError
    })
    t.mock.method(fs, 'unlinkSync', () => {
        throw cleanupError
    })
    syncBuiltinESMExports()
    assert.throws(
        () => writeSerializedFileAtomically(path, 'replacement'),
        (error: Error) => {
            assert.ok(error instanceof AggregateError)
            assert.deepEqual(error.errors, [replacementError, cleanupError])
            assert.equal(error.cause, cleanupError)
            const temporary = fs.readdirSync(directory).find((name) => name.endsWith('.tmp'))
            assert.ok(temporary)
            assert.ok(error.message.includes(join(directory, temporary)))
            assert.equal(fs.readFileSync(join(directory, temporary), 'utf8'), 'replacement')
            return true
        }
    )
    assert.equal(fs.readFileSync(path, 'utf8'), 'original')
})

test('read failure propagates before creating a temporary file', (t) => {
    const { directory, path } = fixture(t)
    fs.writeFileSync(path, 'original')
    const failure = new Error('read denied')
    t.mock.method(fs, 'readFileSync', () => {
        throw failure
    })
    syncBuiltinESMExports()
    assert.throws(
        () => writeSerializedFileAtomically(path, 'replacement'),
        (error) => error === failure
    )
    assert.deepEqual(fs.readdirSync(directory), ['de.json'])
})

test('temporary file creation failure leaves existing destination intact', (t) => {
    const { directory, path } = fixture(t)
    fs.writeFileSync(path, 'original')
    const failure = new Error('write denied')
    t.mock.method(fs, 'writeFileSync', () => {
        throw failure
    })
    syncBuiltinESMExports()
    assert.throws(
        () => writeSerializedFileAtomically(path, 'replacement'),
        (error) => error === failure
    )
    assert.equal(fs.readFileSync(path, 'utf8'), 'original')
    assert.deepEqual(fs.readdirSync(directory), ['de.json'])
})

test('exclusive temporary creation preserves a colliding file and the destination', (t) => {
    const { directory, path } = fixture(t)
    fs.writeFileSync(path, 'original')
    const temporary = join(directory, '.de.json.fixture.tmp')
    fs.writeFileSync(temporary, 'existing temporary content')
    t.mock.method(crypto, 'randomUUID', () => 'fixture')
    syncBuiltinESMExports()
    assert.throws(() => writeSerializedFileAtomically(path, 'replacement'), { code: 'EEXIST' })
    assert.equal(fs.readFileSync(path, 'utf8'), 'original')
    assert.equal(fs.readFileSync(temporary, 'utf8'), 'existing temporary content')
    assert.deepEqual(fs.readdirSync(directory).sort(), ['.de.json.fixture.tmp', 'de.json'])
})
