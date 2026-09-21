import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { GameId, InstalledMod } from '../../../shared/types'
import { api } from '../api'
import { refreshInstalled } from '../gameData'
import { t } from '../i18n'
import { handleInstallOutcome } from '../installSentinels'
import type { ZipMultiPakPayload } from '../components/ZipPickerModal'
import type { HostPackPayload } from '../components/HostPackModal'
import type { CbFlatArchivePayload } from '../components/CrimeBossFlatArchiveModal'
import type { LoaderReplacePayload } from '../components/Ue4ssReplaceModal'

export type DropResult = { kind: 'done' | 'error'; message: string }

export type DropSentinel =
    | { kind: 'zip'; payload: ZipMultiPakPayload }
    | { kind: 'host'; payload: HostPackPayload }
    | { kind: 'cb'; payload: CbFlatArchivePayload }
    | { kind: 'loader'; payload: LoaderReplacePayload }

export interface FileDropTarget {
    gamePath: string | null
    activeGame: GameId
    installed: InstalledMod[]
}

function baseName(path: string): string {
    return path.split(/[\\/]/).pop() || path
}

type InstallTarget = FileDropTarget & { gamePath: string }

export function useFileDropInstall(target: FileDropTarget | null) {
    const [operationTarget, setOperationTarget] = useState<InstallTarget | null>(null)
    const [dragging, setDragging] = useState(false)
    const [installing, setInstalling] = useState(false)
    const [progress, setProgress] = useState<{
        current: number
        total: number
        name: string
    } | null>(null)
    const [result, setResult] = useState<DropResult | null>(null)
    const [prompts, setPrompts] = useState<{ target: InstallTarget; sentinel: DropSentinel }[]>([])
    // Latest values for the event callback, so it never re-subscribes mid-drag.
    const optsRef = useRef(target)
    useLayoutEffect(() => {
        optsRef.current = target
        if (!target) setDragging(false)
    }, [target])
    // Blocks a fresh drop while a picker modal from a previous drop is still open.
    const busyRef = useRef(false)
    useLayoutEffect(() => {
        busyRef.current = installing || prompts.length > 0
    })
    const resultTimer = useRef<number | null>(null)

    function showResult(r: DropResult) {
        if (resultTimer.current) window.clearTimeout(resultTimer.current)
        setResult(r)
        resultTimer.current = window.setTimeout(() => setResult(null), 6000)
    }

    async function runInstall(paths: string[], opts: InstallTarget) {
        busyRef.current = true
        setOperationTarget(opts)
        setInstalling(true)
        setResult(null)
        let ok = 0
        let unrecognized = false
        const failed: string[] = []
        const collected: DropSentinel[] = []
        for (let i = 0; i < paths.length; i++) {
            const path = paths[i]
            setProgress({ current: i + 1, total: paths.length, name: baseName(path) })
            try {
                const outcome = await api.installDroppedFile(path, opts.gamePath, opts.activeGame)
                const prompted = handleInstallOutcome(outcome, {
                    onZipMultiPak: (payload) => collected.push({ kind: 'zip', payload }),
                    onHostModPack: (payload) => collected.push({ kind: 'host', payload }),
                    onCbFlatArchive: (payload) => collected.push({ kind: 'cb', payload }),
                    onLoaderReplace: (payload) => collected.push({ kind: 'loader', payload }),
                    onUnrecognizedArchive: () => {
                        unrecognized = true
                    },
                })
                if (!prompted) ok++
            } catch {
                failed.push(baseName(path))
            }
        }
        let refreshError: string | null = null
        try {
            await refreshInstalled(opts.activeGame)
        } catch (error) {
            refreshError = String(error)
        }
        setInstalling(false)
        setProgress(null)

        if (failed.length > 0 || refreshError !== null) {
            const installError =
                failed.length > 0 ? t('drop.failed', { names: failed.join(', ') }) : null
            showResult({
                kind: 'error',
                message: [installError, refreshError].filter(Boolean).join('\n'),
            })
        } else if (ok > 0) {
            const base = ok === 1 ? t('drop.installedSingle') : t('drop.installed', { count: ok })
            showResult({
                kind: 'done',
                message: unrecognized ? `${base}. ${t('drop.needsPicker')}` : base,
            })
        } else if (unrecognized && collected.length === 0) {
            showResult({ kind: 'error', message: t('drop.needsPicker') })
        }

        setPrompts(collected.map((sentinel) => ({ target: opts, sentinel })))
    }

    useEffect(() => {
        return api.onFileDrop((info) => {
            const opts = optsRef.current
            if (!opts) {
                setDragging(false)
                return
            }
            if (info.type === 'enter' || info.type === 'over') {
                if (!busyRef.current) setDragging(true)
                return
            }
            setDragging(false)
            if (info.type === 'leave' || info.paths.length === 0 || busyRef.current) return
            if (!opts.gamePath) {
                showResult({ kind: 'error', message: t('drop.noGame') })
                return
            }
            void runInstall(info.paths, { ...opts, gamePath: opts.gamePath })
        })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(
        () => () => {
            if (resultTimer.current) window.clearTimeout(resultTimer.current)
        },
        []
    )

    return {
        operationTarget,
        dragging,
        installing,
        progress,
        result,
        dismissResult: () => setResult(null),
        prompt: prompts[0],
        resolvePrompt: () => setPrompts((remaining) => remaining.slice(1)),
    }
}
