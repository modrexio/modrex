import { useEffect, useState } from 'react'
import { PackagePlus, CircleCheck, CircleAlert, Loader2, X } from 'lucide-react'
import { t } from '../i18n'
import type { DropResult } from '../hooks/useFileDropInstall'

// Keeps children mounted through the exit transition: flips `shown` on the next frame
// after mount (enter), and delays unmount by the transition duration on `active=false`.
function useMountTransition(active: boolean, durationMs: number) {
    const [render, setRender] = useState(active)
    const [shown, setShown] = useState(false)
    useEffect(() => {
        if (active) {
            setRender(true)
            const id = requestAnimationFrame(() => setShown(true))
            return () => cancelAnimationFrame(id)
        }
        setShown(false)
        const timer = window.setTimeout(() => setRender(false), durationMs)
        return () => window.clearTimeout(timer)
    }, [active, durationMs])
    return { render, shown }
}

export function FileDropOverlay({
    active,
    installing,
    progress,
    gameName,
}: {
    active: boolean
    installing: boolean
    progress: { current: number; total: number; name: string } | null
    gameName: string
}) {
    const { render, shown } = useMountTransition(active, 200)
    if (!render) return null
    const multi = installing && progress && progress.total > 1
    // Starts below the h-10 title bar so its drag region and window controls stay visible
    // and usable during a drop/install; pointer-events-none keeps the app clickable too.
    return (
        <div
            className={`pointer-events-none fixed inset-x-0 bottom-0 top-10 z-[9998] bg-surface/70 backdrop-blur-sm transition-opacity duration-200 ${
                shown ? 'opacity-100' : 'opacity-0'
            }`}
        >
            <div
                className={`absolute inset-4 flex flex-col items-center justify-center gap-4 rounded-lg border-2 border-dashed border-accent bg-surface-raised/40 transition-transform duration-200 ${
                    shown ? 'scale-100' : 'scale-[0.98]'
                }`}
            >
                {installing ? (
                    <>
                        <Loader2 className="h-14 w-14 animate-spin text-accent" />
                        <div className="text-xl font-semibold text-text">
                            {multi
                                ? t('drop.installingCount', {
                                      current: progress.current,
                                      total: progress.total,
                                  })
                                : t('drop.installing')}
                        </div>
                        {multi && (
                            <div className="max-w-md truncate px-4 text-sm text-text-muted">
                                {progress.name}
                            </div>
                        )}
                    </>
                ) : (
                    <>
                        <PackagePlus className="h-14 w-14 text-accent" />
                        <div className="text-xl font-semibold text-text">
                            {t('drop.overlayTitle')}
                        </div>
                        <div className="text-sm text-text-muted">
                            {t('drop.overlaySubtitle', { game: gameName })}
                        </div>
                    </>
                )}
            </div>
        </div>
    )
}

export function FileDropStatus({
    result,
    onDismiss,
}: {
    result: DropResult
    onDismiss: () => void
}) {
    const [shown, setShown] = useState(false)
    useEffect(() => {
        const id = requestAnimationFrame(() => setShown(true))
        return () => cancelAnimationFrame(id)
    }, [])
    const Icon = result.kind === 'done' ? CircleCheck : CircleAlert
    const tone =
        result.kind === 'error'
            ? 'border-danger/40 text-danger-text'
            : 'border-success/40 text-success-text'
    return (
        <div className="fixed bottom-4 left-1/2 z-[9997] -translate-x-1/2">
            <div
                className={`flex items-center gap-2 rounded-lg border bg-surface-raised px-4 py-2 text-sm shadow-lg transition-all duration-200 ${tone} ${
                    shown ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
                }`}
            >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{result.message}</span>
                <button onClick={onDismiss} className="ml-1 text-text-subtle hover:text-text">
                    <X className="h-3.5 w-3.5" />
                </button>
            </div>
        </div>
    )
}
