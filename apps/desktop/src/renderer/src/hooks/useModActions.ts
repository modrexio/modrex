import { useEffect, useRef, useState } from 'react'
import type { GameId, InstalledMod } from '../../../shared/types'
import type { ZipMultiPakPayload } from '../components/ZipPickerModal'
import { installZipPickerEntries } from '../components/ZipPickerModal'
import type { HostPackPayload } from '../components/HostPackModal'
import type { CbFlatArchivePayload } from '../components/CrimeBossFlatArchiveModal'
import { handleInstallOutcome } from '../installSentinels'
import { entryFilename, stripPriorityPrefix } from './installedUtils'
import { t } from '../i18n'
import { api } from '../api'

export type IdentifyNexusResult = { kind: 'done' | 'error'; message: string }

export interface ModActions {
    loadingMod: string | null
    reinstallProgress: { downloaded: number; total: number } | null
    reinstallError: string | null
    clearReinstallError: () => void
    refreshing: boolean
    zipPickerData: ZipMultiPakPayload | null
    clearZipPickerData: () => void
    hostPackData: HostPackPayload | null
    clearHostPackData: () => void
    unrecognizedModId: number | null
    clearUnrecognizedModId: () => void
    cbFlatArchiveData: CbFlatArchivePayload | null
    clearCbFlatArchiveData: () => void
    movingCrimeBossTarget: InstalledMod | null
    crimeBossMoveBusy: boolean
    crimeBossMoveError: string | null
    identifyNexusResult: IdentifyNexusResult | null
    dismissIdentifyNexusResult: () => void
    handleRefresh: () => Promise<void>
    handleUninstall: (mods: InstalledMod[]) => Promise<void>
    handleEnable: (mods: InstalledMod[]) => Promise<void>
    handleDisable: (mods: InstalledMod[]) => Promise<void>
    handleReinstall: (mods: InstalledMod[]) => Promise<void>
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
    const [reinstallProgress, setReinstallProgress] = useState<{
        downloaded: number
        total: number
    } | null>(null)
    const [reinstallError, setReinstallError] = useState<string | null>(null)
    const [refreshing, setRefreshing] = useState(false)
    const [zipPickerData, setZipPickerData] = useState<ZipMultiPakPayload | null>(null)
    const [hostPackData, setHostPackData] = useState<HostPackPayload | null>(null)
    const [unrecognizedModId, setUnrecognizedModId] = useState<number | null>(null)
    const [cbFlatArchiveData, setCbFlatArchiveData] = useState<CbFlatArchivePayload | null>(null)
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

    async function handleUninstall(mods: InstalledMod[]) {
        if (!gamePath) return
        setLoadingMod(mods[0].uid)
        try {
            for (const m of mods) await api.uninstallMod(m.uid, gamePath, activeGame)
            await onRefreshInstalled()
        } finally {
            setLoadingMod(null)
        }
    }

    async function handleEnable(mods: InstalledMod[]) {
        if (!gamePath) return
        setLoadingMod(mods[0].uid)
        try {
            for (const m of mods) await api.enableMod(m.uid, gamePath, activeGame)
            await onRefreshInstalled()
        } finally {
            setLoadingMod(null)
        }
    }

    async function handleDisable(mods: InstalledMod[]) {
        if (!gamePath) return
        setLoadingMod(mods[0].uid)
        try {
            for (const m of mods) await api.disableMod(m.uid, gamePath, activeGame)
            await onRefreshInstalled()
        } finally {
            setLoadingMod(null)
        }
    }

    // Tier 3 identification (see nexus_content.rs): a miss or an ambiguous result is
    // expected for roughly a quarter of mods, so both surface as an info toast, not an
    // error — only a genuine request failure does.
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

    async function handleReinstall(mods: InstalledMod[]) {
        // Reinstall goes through the modworkshop-only api.installMod, which needs a
        // real modworkshop id — InstalledMod.id is an opaque local key, never that.
        const isModworkshop = !mods[0].source || mods[0].source === 'modworkshop'
        const remoteId = Number(mods[0].remoteId)
        if (!gamePath || !isModworkshop || !Number.isFinite(remoteId) || remoteId <= 0) return

        const missingMods = mods.filter((m) => m.missing)

        setLoadingMod(mods[0].uid)
        setReinstallProgress(null)
        setReinstallError(null)

        // ZIP-installed paks use {file_id}_{stem} uids; install_mod creates {file_id} — old entries stay missing without this.
        for (const m of missingMods) {
            await api.uninstallMod(m.uid, gamePath, activeGame)
        }

        const targetId = `mod:${remoteId}`
        const unsub = api.onDownloadProgress(({ download_id, downloaded, total }) => {
            if (download_id === targetId) setReinstallProgress({ downloaded, total })
        })
        try {
            const outcome = await api.installMod(remoteId, gamePath, activeGame)
            if (typeof outcome !== 'string' && 'needsPicker' in outcome) {
                const zipPayload = outcome.needsPicker as unknown as ZipMultiPakPayload
                // install_from_zip_entry's pre-removal only fires when exactly one other entry
                // shares the mod id; for multi-pak mods (2+ entries) stale entries survive and
                // keep the group outdated. missingMods were already removed above.
                // ZipPickerModal is also blocked by Radix's focus trap when HealthCheckModal is open.
                const priorMods = mods.filter((m) => !m.missing)
                for (const m of priorMods) {
                    await api.uninstallMod(m.uid, gamePath, activeGame)
                }
                const toReinstall = zipPayload.entries.filter((entry) =>
                    priorMods.some((m) => stripPriorityPrefix(m.filename) === entryFilename(entry))
                )
                if (toReinstall.length > 0) {
                    try {
                        await installZipPickerEntries(
                            zipPayload,
                            toReinstall,
                            gamePath,
                            activeGame,
                            mods[0].folderId ?? null,
                            onRefreshInstalled
                        )
                    } catch (installErr) {
                        setReinstallError(String(installErr))
                    }
                } else {
                    setZipPickerData(zipPayload)
                }
            } else {
                handleInstallOutcome(outcome, {
                    onZipMultiPak: setZipPickerData, // unreachable: the needsPicker branch above
                    onHostModPack: setHostPackData,
                    onCbFlatArchive: setCbFlatArchiveData,
                    onUnrecognizedArchive: () => setUnrecognizedModId(remoteId),
                })
            }
        } catch (e) {
            setReinstallError(String(e))
        } finally {
            unsub()
            setReinstallProgress(null)
            setLoadingMod(null)
        }
        await onRefreshInstalled()
    }

    // Both directions ask for confirmation before moving — Mods/ (ModKit) -> ~mods drops Data
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
        reinstallProgress,
        reinstallError,
        clearReinstallError: () => setReinstallError(null),
        refreshing,
        zipPickerData,
        clearZipPickerData: () => setZipPickerData(null),
        hostPackData,
        clearHostPackData: () => setHostPackData(null),
        unrecognizedModId,
        clearUnrecognizedModId: () => setUnrecognizedModId(null),
        cbFlatArchiveData,
        clearCbFlatArchiveData: () => setCbFlatArchiveData(null),
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
