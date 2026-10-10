import type { InstallOutcome } from './api'
import { t } from './i18n'
import type { ZipMultiPakPayload } from './components/ZipPickerModal'
import type { HostPackPayload } from './components/HostPackModal'
import type { CbFlatArchivePayload } from './components/CrimeBossFlatArchiveModal'
import type { LoaderReplacePayload } from './components/Ue4ssReplaceModal'

/** Every ordinary archive choice has a required handler, so missing UI wiring fails compilation. */
export interface InstallSentinelHandlers {
    onZipMultiPak: (payload: ZipMultiPakPayload) => void
    onHostModPack: (payload: HostPackPayload) => void
    onCbFlatArchive: (payload: CbFlatArchivePayload) => void
    onLoaderReplace: (payload: LoaderReplacePayload) => void
    onUnrecognizedArchive: () => void
}

/** Dependency rows surface an archive choice they cannot offer instead of claiming success. */
export function uninstallablePromptMessage(outcome: InstallOutcome): string | null {
    if (outcome === 'installed') return null
    if (outcome === 'cancelled') return t('resources.install.cancelled')
    return t('common.depNeedsManualInstall')
}

/** Dispatches archive choices after api has completed resource review. Returns false after installation. */
export function handleInstallOutcome(
    outcome: InstallOutcome,
    handlers: InstallSentinelHandlers
): boolean {
    if (outcome === 'installed') return false
    if (outcome === 'cancelled') return true
    if (outcome === 'unrecognized') {
        handlers.onUnrecognizedArchive()
        return true
    }
    if ('needsPicker' in outcome) {
        handlers.onZipMultiPak(outcome.needsPicker as unknown as ZipMultiPakPayload)
        return true
    }
    if ('needsHostChoice' in outcome) {
        handlers.onHostModPack(outcome.needsHostChoice as unknown as HostPackPayload)
        return true
    }
    if ('needsLoaderConfirm' in outcome) {
        handlers.onLoaderReplace(outcome.needsLoaderConfirm as unknown as LoaderReplacePayload)
        return true
    }
    handlers.onCbFlatArchive(outcome.needsCbFlatConfirm as unknown as CbFlatArchivePayload)
    return true
}
