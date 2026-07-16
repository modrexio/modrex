import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { GameId } from '../../../shared/types'
import { api } from '../api'
import { t } from '../i18n'

export type DropResult = { kind: 'done' | 'error'; message: string }

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
    // Latest values for the event callback, so it never re-subscribes mid-drag.
    const optsRef = useRef<Options>({ gamePath, activeGame, enabled, onRefreshInstalled })
    useLayoutEffect(() => {
        optsRef.current = { gamePath, activeGame, enabled, onRefreshInstalled }
    })
    const installingRef = useRef(false)
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
        let needsPicker = false
        const failed: string[] = []
        for (let i = 0; i < paths.length; i++) {
            const path = paths[i]
            setProgress({ current: i + 1, total: paths.length, name: baseName(path) })
            try {
                await api.installDroppedFile(path, opts.gamePath, undefined, opts.activeGame)
                ok++
            } catch (e) {
                if (String(e).includes('DROP_NEEDS_PICKER')) needsPicker = true
                else failed.push(baseName(path))
            }
        }
        await opts.onRefreshInstalled()
        installingRef.current = false
        setInstalling(false)
        setProgress(null)

        if (failed.length > 0) {
            showResult({ kind: 'error', message: t('drop.failed', { names: failed.join(', ') }) })
        } else if (ok === 0 && needsPicker) {
            showResult({ kind: 'error', message: t('drop.needsPicker') })
        } else {
            const base = ok === 1 ? t('drop.installedSingle') : t('drop.installed', { count: ok })
            showResult({
                kind: 'done',
                message: needsPicker ? `${base} · ${t('drop.needsPicker')}` : base,
            })
        }
    }

    useEffect(() => {
        return api.onFileDrop((info) => {
            const opts = optsRef.current
            if (!opts.enabled) {
                setDragging(false)
                return
            }
            if (info.type === 'enter' || info.type === 'over') {
                if (!installingRef.current) setDragging(true)
                return
            }
            setDragging(false)
            if (info.type === 'leave' || info.paths.length === 0 || installingRef.current) return
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

    return { dragging, installing, progress, result, dismissResult: () => setResult(null) }
}
