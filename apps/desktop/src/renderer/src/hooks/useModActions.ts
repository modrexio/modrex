import { useEffect, useRef, useState } from 'react'
import type { GameId, InstalledMod, Mod, ModFile } from '../../../shared/types'
import type { ZipMultiPakPayload } from '../components/ZipPickerModal'
import { installZipPickerEntries } from '../components/ZipPickerModal'
import { isLoader } from './installedUtils'
import { requestInstallChoice } from '../installChoices'
import { archiveHandleForOutcome } from '../installState'
import { entryFilename, stripPriorityPrefix } from './installedUtils'
import { t } from '../i18n'
import { api, type InstallOutcome } from '../api'
import { runBulkAction } from '../bulkAction'
import { getCachedModFiles, refreshModDetail } from '../modCache'
import { defaultFileIsUnambiguous } from '../updatePolicy'

export type IdentifyNexusResult = { kind: 'done' | 'error'; message: string }

export interface ModActions {
    loadingMod: string | null
    modActionError: string | null
    clearModActionError: () => void
    reinstallError: string | null
    clearReinstallError: () => void
    reinstallChoice: { mods: InstalledMod[]; mod: Mod; files: ModFile[] } | null
    chooseReinstallFile: (fileId: number) => Promise<void>
    clearReinstallChoice: () => void
    refreshing: boolean
    removingLoader: boolean
    clearRemovingLoader: () => void
    movingCrimeBossTarget: InstalledMod | null
    crimeBossMoveBusy: boolean
    crimeBossMoveError: string | null
    identifyNexusResult: IdentifyNexusResult | null
    dismissIdentifyNexusResult: () => void
    handleRefresh: () => Promise<void>
    handleUninstall: (mods: InstalledMod[]) => Promise<void>
    handleEnable: (mods: InstalledMod[]) => Promise<void>
    handleDisable: (mods: InstalledMod[]) => Promise<void>
    handleReinstall: (mods: InstalledMod[]) => Promise<string | null>
    handleIdentifyViaNexus: (mod: InstalledMod) => Promise<void>
    requestMoveCrimeBossTarget: (mod: InstalledMod) => void
    confirmMoveCrimeBossTarget: () => Promise<void>
    cancelMoveCrimeBossTarget: () => void
}

export function useModActions(
    gamePath: string | null,
    onRefreshInstalled: () => Promise<void>,
    activeGame: GameId
): ModActions {
    const [loadingMod, setLoadingMod] = useState<string | null>(null)
    const [modActionError, setModActionError] = useState<string | null>(null)
    const [reinstallError, setReinstallError] = useState<string | null>(null)
    const [reinstallChoices, setReinstallChoices] = useState<
        NonNullable<ModActions['reinstallChoice']>[]
    >([])
    const reinstallChoice = reinstallChoices[0] ?? null
    const [refreshing, setRefreshing] = useState(false)
    const [removingLoader, setRemovingLoader] = useState(false)
    const [movingCrimeBossTarget, setMovingCrimeBossTarget] = useState<InstalledMod | null>(null)
    const [crimeBossMoveBusy, setCrimeBossMoveBusy] = useState(false)
    const [crimeBossMoveError, setCrimeBossMoveError] = useState<string | null>(null)
    const [identifyNexusResult, setIdentifyNexusResult] = useState<IdentifyNexusResult | null>(null)
    const identifyNexusResultTimer = useRef<number | null>(null)

    function showIdentifyNexusResult(r: IdentifyNexusResult) {
        if (identifyNexusResultTimer.current) window.clearTimeout(identifyNexusResultTimer.current)
        setIdentifyNexusResult(r)
        identifyNexusResultTimer.current = window.setTimeout(
            () => setIdentifyNexusResult(null),
            6000
        )
    }

    useEffect(
        () => () => {
            if (identifyNexusResultTimer.current)
                window.clearTimeout(identifyNexusResultTimer.current)
        },
        []
    )

    async function handleRefresh() {
        setRefreshing(true)
        try {
            await onRefreshInstalled()
        } finally {
            setRefreshing(false)
        }
    }

    // Every one of these attempts all of its mods, then refreshes once whether or not any
    // failed, so the list shows what is actually on disk rather than what was asked for.
    async function runOnEach(mods: InstalledMod[], run: (m: InstalledMod) => Promise<void>) {
        if (!gamePath) return
        setLoadingMod(mods[0].uid)
        setModActionError(null)
        try {
            setModActionError(await runBulkAction(mods, (m) => m.name, run, onRefreshInstalled))
        } finally {
            setLoadingMod(null)
        }
    }

    async function handleUninstall(mods: InstalledMod[]) {
        // A loader is detected rather than tracked, so no mod record names its files and
        // uninstall_mod has nothing to act on. Removing it is its own operation, and it
        // shows what it would delete first.
        if (mods.every(isLoader)) {
            setRemovingLoader(true)
            return
        }
        await runOnEach(mods, (m) => api.uninstallMod(m.uid, gamePath!, activeGame))
    }

    async function handleEnable(mods: InstalledMod[]) {
        await runOnEach(mods, (m) => api.enableMod(m.uid, gamePath!, activeGame))
    }

    async function handleDisable(mods: InstalledMod[]) {
        await runOnEach(mods, (m) => api.disableMod(m.uid, gamePath!, activeGame))
    }

    // Tier 3 identification (see nexus_content.rs): a miss or an ambiguous result is
    // expected for roughly a quarter of mods, so both surface as an info toast, not an
    // error. Only a genuine request failure does.
    async function handleIdentifyViaNexus(mod: InstalledMod) {
        if (!gamePath) return
        setLoadingMod(mod.uid)
        try {
            const outcome = await api.identifyModViaNexusContent(mod.uid, gamePath, activeGame)
            await onRefreshInstalled()
            if (outcome === 'notFound') {
                showIdentifyNexusResult({
                    kind: 'done',
                    message: t('installed.identifyNexus.notFound'),
                })
            } else if (outcome === 'skipped') {
                // Reached when a permanent miss was already recorded on an earlier attempt
                // (identify_via_nexus_content_op never re-queries once nexus_content_missed is
                // set) - still worth a toast, since a click that visibly does nothing reads as
                // broken rather than as "nothing new to check".
                showIdentifyNexusResult({
                    kind: 'done',
                    message: t('installed.identifyNexus.alreadyChecked'),
                })
            } else if (outcome === 'ambiguous') {
                showIdentifyNexusResult({
                    kind: 'done',
                    message: t('installed.identifyNexus.ambiguous'),
                })
            } else if (outcome === 'identified') {
                showIdentifyNexusResult({
                    kind: 'done',
                    message: t('installed.identifyNexus.identified', { name: mod.name }),
                })
            }
        } catch (e) {
            showIdentifyNexusResult({
                kind: 'error',
                message: t('installed.identifyNexus.error', { error: String(e) }),
            })
        } finally {
            setLoadingMod(null)
        }
    }

    // Resolves to the failure, or null when it installed or is waiting on a choice.
    async function handleReinstall(mods: InstalledMod[]): Promise<string | null> {
        // Reinstall goes through the modworkshop-only api.installMod, which needs a
        // real modworkshop id. InstalledMod.id is an opaque local key, never that.
        const isModworkshop = !mods[0].source || mods[0].source === 'modworkshop'
        const remoteId = Number(mods[0].remoteId)
        if (!gamePath || !isModworkshop || !Number.isFinite(remoteId) || remoteId <= 0) return null

        setLoadingMod(mods[0].uid)
        setReinstallError(null)
        let found: [Mod, ModFile[]]
        try {
            found = await Promise.all([refreshModDetail(remoteId), getCachedModFiles(remoteId)])
        } catch (e) {
            setReinstallError(String(e))
            setLoadingMod(null)
            return String(e)
        }
        const [detail, files] = found
        const fileIds = new Set(mods.map((m) => m.fileId))
        const installedFile = files.find((f) => fileIds.size === 1 && fileIds.has(f.id))
        if (installedFile) return reinstall(mods, remoteId, installedFile.id)
        if (!files.length || defaultFileIsUnambiguous(mods, detail, files))
            return reinstall(mods, remoteId)
        setLoadingMod(null)
        setReinstallChoices((prev) => [...prev, { mods, mod: detail, files }])
        return null
    }

    async function chooseReinstallFile(fileId: number) {
        if (!reinstallChoice) return
        setReinstallChoices((prev) => prev.slice(1))
        await reinstall(reinstallChoice.mods, reinstallChoice.mod.id, fileId)
    }

    async function reinstall(
        mods: InstalledMod[],
        remoteId: number,
        fileId?: number
    ): Promise<string | null> {
        if (!gamePath) return null
        let failure: string | null = null
        let archiveOutcome: Exclude<InstallOutcome, string> | null = null
        const missingMods = mods.filter((m) => m.missing && !m.deployment)

        setLoadingMod(mods[0].uid)
        setReinstallError(null)
        try {
            // Archive entries and direct files have different record keys, so a missing
            // entry must be removed before installing its replacement.
            for (const m of missingMods) {
                await api.uninstallMod(m.uid, gamePath, activeGame)
            }
            const outcome = await api.installMod(remoteId, gamePath, activeGame, fileId)
            if (typeof outcome === 'object') archiveOutcome = outcome
            if (typeof outcome !== 'string' && 'needsPicker' in outcome) {
                const zipPayload = outcome.needsPicker as unknown as ZipMultiPakPayload
                // Archive installation keeps unselected entries, so remove the prior
                // files before restoring the matching variants.
                const priorMods = mods.filter((m) => !m.missing)
                for (const m of priorMods) {
                    await api.uninstallMod(m.uid, gamePath, activeGame)
                }
                const toReinstall = zipPayload.entries
                    .map((entry, pos) => ({ entry, pos }))
                    .filter(({ entry }) =>
                        priorMods.some(
                            (m) => stripPriorityPrefix(m.filename) === entryFilename(entry)
                        )
                    )
                    .map(({ pos }) => pos)
                if (toReinstall.length > 0) {
                    await installZipPickerEntries(
                        zipPayload,
                        toReinstall,
                        gamePath,
                        activeGame,
                        mods[0].folderId ?? null,
                        onRefreshInstalled
                    )
                } else {
                    await requestInstallChoice(
                        outcome,
                        activeGame,
                        gamePath,
                        mods,
                        mods[0].folderId ?? null,
                        remoteId
                    )
                }
            } else {
                await requestInstallChoice(
                    outcome,
                    activeGame,
                    gamePath,
                    mods,
                    mods[0].folderId ?? null,
                    remoteId
                )
            }
        } catch (e) {
            failure = String(e)
            if (archiveOutcome) {
                try {
                    await api.discardStagedArchive(archiveHandleForOutcome(archiveOutcome))
                } catch (cleanupError) {
                    failure += '\n' + String(cleanupError)
                    await requestInstallChoice(
                        archiveOutcome,
                        activeGame,
                        gamePath,
                        mods,
                        mods[0].folderId ?? null,
                        remoteId,
                        String(cleanupError)
                    )
                }
            }
            setReinstallError(failure)
        } finally {
            setLoadingMod(null)
        }
        try {
            await onRefreshInstalled()
        } catch (refreshError) {
            failure = [failure, String(refreshError)].filter(Boolean).join('\n')
            setReinstallError(failure)
        }
        return failure
    }

    // Both directions ask for confirmation before moving. Mods/ (ModKit) to ~mods drops Data
    // Table merge behavior, ~mods -> Mods/ only gains it, but either way the move is silent
    // otherwise, so the dialog is also the only feedback that anything happened.
    function requestMoveCrimeBossTarget(mod: InstalledMod) {
        setCrimeBossMoveError(null)
        setMovingCrimeBossTarget(mod)
    }

    async function doMoveCrimeBossTarget(mod: InstalledMod) {
        if (!gamePath) return
        setCrimeBossMoveBusy(true)
        setCrimeBossMoveError(null)
        try {
            await api.moveCrimeBossModTarget(mod.uid, gamePath)
            await onRefreshInstalled()
            setMovingCrimeBossTarget(null)
        } catch (e) {
            setCrimeBossMoveError(String(e))
        } finally {
            setCrimeBossMoveBusy(false)
        }
    }

    async function confirmMoveCrimeBossTarget() {
        if (movingCrimeBossTarget) await doMoveCrimeBossTarget(movingCrimeBossTarget)
    }

    function cancelMoveCrimeBossTarget() {
        setMovingCrimeBossTarget(null)
        setCrimeBossMoveError(null)
    }

    return {
        loadingMod,
        modActionError,
        clearModActionError: () => setModActionError(null),
        reinstallError,
        clearReinstallError: () => setReinstallError(null),
        reinstallChoice,
        chooseReinstallFile,
        clearReinstallChoice: () => setReinstallChoices((prev) => prev.slice(1)),
        refreshing,
        removingLoader,
        clearRemovingLoader: () => setRemovingLoader(false),
        movingCrimeBossTarget,
        crimeBossMoveBusy,
        crimeBossMoveError,
        identifyNexusResult,
        dismissIdentifyNexusResult: () => setIdentifyNexusResult(null),
        handleRefresh,
        handleUninstall,
        handleEnable,
        handleDisable,
        handleReinstall,
        handleIdentifyViaNexus,
        requestMoveCrimeBossTarget,
        confirmMoveCrimeBossTarget,
        cancelMoveCrimeBossTarget,
    }
}
