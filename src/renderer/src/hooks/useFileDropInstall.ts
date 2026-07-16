import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { GameId } from '../../../shared/types'
import { api } from '../api'
import { t } from '../i18n'
import { handleInstallSentinel } from '../installSentinels'
import type { ZipMultiPakPayload } from '../components/ZipPickerModal'
import type { HostPackPayload } from '../components/HostPackModal'
import type { CbFlatArchivePayload } from '../components/CrimeBossFlatArchiveModal'

export type DropResult = { kind: 'done' | 'error'; message: string }

export type DropSentinel =
    | { kind: 'zip'; payload: ZipMultiPakPayload }
    | { kind: 'host'; payload: HostPackPayload }
    | { kind: 'cb'; payload: CbFlatArchivePayload }

interface Options {
    gamePath: string | null
    activeGame: GameId
    enabled: boolean
    onRefreshInstalled: () => Promise<void>
}

function baseName(path: string): string {
    return path.split(/[\\/]/).pop() || path
}

// Native OS file drops from Explorer install as unidentified local mods (see
// install_dropped_file). Multi-pak / specially-packaged archives return DROP_NEEDS_PICKER
// until Part 2b wires the archive picker.
export function useFileDropInstall({ gamePath, activeGame, enabled, onRefreshInstalled }: Options) {
    const [dragging, setDragging] = useState(false)
    const [installing, setInstalling] = useState(false)
    const [progress, setProgress] = useState<{
        current: number
        total: number
        name: string
    } | null>(null)
    const [result, setResult] = useState<DropResult | null>(null)
    // Archives that need a UI decision (multi-pak / host pack / CB flat), shown one modal at a time.
    const [sentinels, setSentinels] = useState<DropSentinel[]>([])
    // Latest values for the event callback, so it never re-subscribes mid-drag.
    const optsRef = useRef<Options>({ gamePath, activeGame, enabled, onRefreshInstalled })
    useLayoutEffect(() => {
        optsRef.current = { gamePath, activeGame, enabled, onRefreshInstalled }
    })
    const installingRef = useRef(false)
    // Blocks a fresh drop while a picker modal from a previous drop is still open.
    const busyRef = useRef(false)
    useLayoutEffect(() => {
        busyRef.current = installing || sentinels.length > 0
    })
    const resultTimer = useRef<number | null>(null)

    function showResult(r: DropResult) {
        if (resultTimer.current) window.clearTimeout(resultTimer.current)
        setResult(r)
        resultTimer.current = window.setTimeout(() => setResult(null), 6000)
    }

    async function runInstall(paths: string[], opts: Options) {
        if (!opts.gamePath) return
        installingRef.current = true
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
                await api.installDroppedFile(path, opts.gamePath, undefined, opts.activeGame)
                ok++
            } catch (e) {
                const handled = handleInstallSentinel(String(e), {
                    onZipMultiPak: (payload) => collected.push({ kind: 'zip', payload }),
                    onHostModPack: (payload) => collected.push({ kind: 'host', payload }),
                    onCbFlatArchive: (payload) => collected.push({ kind: 'cb', payload }),
                    onUnrecognizedArchive: () => {
                        unrecognized = true
                    },
                })
                if (!handled) failed.push(baseName(path))
            }
        }
        await opts.onRefreshInstalled()
        installingRef.current = false
        setInstalling(false)
        setProgress(null)

        // Sentinels get their own modals; only the directly-resolved outcomes drive the toast.
        if (failed.length > 0) {
            showResult({ kind: 'error', message: t('drop.failed', { names: failed.join(', ') }) })
        } else if (ok > 0) {
            const base = ok === 1 ? t('drop.installedSingle') : t('drop.installed', { count: ok })
            showResult({
                kind: 'done',
                message: unrecognized ? `${base} · ${t('drop.needsPicker')}` : base,
            })
        } else if (unrecognized && collected.length === 0) {
            showResult({ kind: 'error', message: t('drop.needsPicker') })
        }

        if (collected.length > 0) setSentinels(collected)
    }

    useEffect(() => {
        return api.onFileDrop((info) => {
            const opts = optsRef.current
            if (!opts.enabled) {
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
            void runInstall(info.paths, opts)
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
        dragging,
        installing,
        progress,
        result,
        dismissResult: () => setResult(null),
        sentinel: sentinels[0] ?? null,
        resolveSentinel: () => setSentinels((s) => s.slice(1)),
    }
}
