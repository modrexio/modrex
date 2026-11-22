import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { REPOSITORY_ROOT } from './i18n-config.mts'
import { serializeLocale } from './i18n-files.mts'
import { describeHistoryAvailability } from './i18n-history.mts'
import { synchronizeI18n } from './i18n-sync.mts'

export const repositoryHistorySkipReason = describeHistoryAvailability({ cwd: REPOSITORY_ROOT })
    .available
    ? false
    : 'authoritative history is unavailable'

// Presentation tests need synchronized markers even when the bot has not run yet.
// Materialize its validated plan in a temporary directory to preserve tracked locales.
export function createSynchronizedRepositoryLocales(context: Pick<TestContext, 'after'>) {
    const { plan } = synchronizeI18n({ cwd: REPOSITORY_ROOT, write: () => false })
    const i18nDir = mkdtempSync(join(tmpdir(), 'modrex-i18n-presentation-'))
    context.after(() => rmSync(i18nDir, { recursive: true, force: true }))
    writeFileSync(join(i18nDir, 'en.json'), serializeLocale(plan.sourceBundle))
    for (const locale of plan.locales) {
        writeFileSync(join(i18nDir, `${locale.id}.json`), serializeLocale(locale.bundle))
    }
    return i18nDir
}
