import { useLayoutEffect, useRef, useState, type AnimationEvent } from 'react'
import { PackagePlus, CircleCheck, CircleAlert, Loader2, X } from 'lucide-react'
import { t } from '../i18n'
import type { DropResult } from '../hooks/useFileDropInstall'

function useExitAnimation(active: boolean) {
    const [render, setRender] = useState(active)
    const ref = useRef<HTMLDivElement>(null)
    useLayoutEffect(() => {
        if (active) {
            setRender(true)
            return
        }
        // An element that runs no animation never fires the end event.
        const animationName = ref.current && getComputedStyle(ref.current).animationName
        if (!animationName || animationName === 'none') setRender(false)
    }, [active])
    function onAnimationEnd(event: AnimationEvent<HTMLDivElement>) {
        if (active || event.target !== event.currentTarget) return
        // Ignore queued enter events during exit, covered by FileDropOverlay.test.tsx.
        if (event.animationName !== getComputedStyle(event.currentTarget).animationName) return
        setRender(false)
    }
    return { render, ref, onAnimationEnd }
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
    const { render, ref, onAnimationEnd } = useExitAnimation(active)
    if (!render) return null
    const multi = installing && progress && progress.total > 1
    // Starts below the h-10 title bar so its drag region and window controls stay visible
    // and usable during a drop/install; pointer-events-none keeps the app clickable too.
    return (
        <div
            ref={ref}
            onAnimationEnd={onAnimationEnd}
            className={`pointer-events-none fixed inset-x-0 bottom-0 top-10 z-[9998] bg-surface/70 backdrop-blur-sm ${
                active ? 'animate-drop-overlay-in' : 'animate-drop-overlay-out'
            }`}
        >
            <div
                className={`absolute inset-4 flex flex-col items-center justify-center gap-4 rounded-lg border-2 border-dashed border-accent bg-surface-raised/40 ${
                    active ? 'animate-drop-panel-in' : 'animate-drop-panel-out'
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
    result: DropResult | null
    onDismiss: () => void
}) {
    const { render, ref, onAnimationEnd } = useExitAnimation(result !== null)
    const [lastResult, setLastResult] = useState(result)
    if (result && result !== lastResult) setLastResult(result)
    const displayResult = result ?? lastResult
    if (!render || !displayResult) return null
    const Icon = displayResult.kind === 'done' ? CircleCheck : CircleAlert
    const tone =
        displayResult.kind === 'error'
            ? 'border-danger/40 text-danger-text'
            : 'border-success/40 text-success-text'
    return (
        <div className="fixed bottom-4 left-1/2 z-[9997] -translate-x-1/2">
            <div
                ref={ref}
                onAnimationEnd={onAnimationEnd}
                className={`flex items-center gap-2 rounded-lg border bg-surface-raised px-4 py-2 text-sm shadow-lg ${tone} ${
                    result ? 'animate-drop-status-in' : 'animate-drop-status-out'
                }`}
            >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{displayResult.message}</span>
                <button onClick={onDismiss} className="ml-1 text-text-subtle hover:text-text">
                    <X className="h-3.5 w-3.5" />
                </button>
            </div>
        </div>
    )
}
