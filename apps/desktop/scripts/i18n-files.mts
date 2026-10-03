import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

export type LocaleBundle = { [key: string]: string | LocaleBundle }

export function serializeLocale(locale: LocaleBundle): string {
    return `${JSON.stringify(locale, null, 4)}\n`
}

export function writeSerializedFileAtomically(filePath: string, serialized: string): boolean {
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
                `Failed to replace '${filePath}' and remove temporary file '${temporaryPath}'`,
                { cause: cleanupError }
            )
        }
        throw new Error(`Failed to replace locale file '${filePath}'`, { cause: error })
    }
    return true
}

export function writeLocaleAtomically(filePath: string, locale: LocaleBundle): boolean {
    return writeSerializedFileAtomically(filePath, serializeLocale(locale))
}
