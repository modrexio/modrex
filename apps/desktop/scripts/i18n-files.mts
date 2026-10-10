import crypto from 'node:crypto'
import fs from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

export type LocaleBundle = { [key: string]: string | LocaleBundle }

export function serializeLocale(locale: LocaleBundle): string {
    return `${JSON.stringify(locale, null, 4)}\n`
}

// fs and crypto are called through their module objects so i18n-files.test.mts can replace
// single methods. Named imports bind at load time and would keep the real functions.
export function writeSerializedFileAtomically(filePath: string, serialized: string): boolean {
    if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === serialized) return false

    const temporaryPath = resolve(
        dirname(filePath),
        `.${basename(filePath)}.${crypto.randomUUID()}.tmp`
    )
    fs.writeFileSync(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx' })

    try {
        fs.renameSync(temporaryPath, filePath)
    } catch (error) {
        try {
            fs.unlinkSync(temporaryPath)
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
