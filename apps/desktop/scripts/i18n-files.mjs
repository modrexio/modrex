import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

export function serializeLocale(locale) {
    return `${JSON.stringify(locale, null, 4)}\n`
}

export function writeSerializedFileAtomically(filePath, serialized) {
    if (existsSync(filePath) && readFileSync(filePath, 'utf8') === serialized) return false

    const temporaryPath = resolve(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`)
    writeFileSync(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx' })

    try {
        renameSync(temporaryPath, filePath)
    } catch (error) {
        try {
            unlinkSync(temporaryPath)
        } catch (cleanupError) {
            throw new AggregateError(
                [error, cleanupError],
                `Failed to replace '${filePath}' and remove temporary file '${temporaryPath}'`
            )
        }
        throw new Error(`Failed to replace locale file '${filePath}'`, { cause: error })
    }
    return true
}

export function writeLocaleAtomically(filePath, locale) {
    return writeSerializedFileAtomically(filePath, serializeLocale(locale))
}
