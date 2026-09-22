import { useState, useEffect } from 'react'
import { api, type ResizeDirection } from '../api'

// Undecorated windows get native edge-resize hit-testing on Windows but not on
// Linux/GTK, so these invisible edge strips call startResizeDragging manually.
// Rendered on Linux only (see App.tsx).
const HANDLES: { direction: ResizeDirection; className: string }[] = [
    { direction: 'North', className: 'top-0 left-2 right-2 h-1 cursor-n-resize' },
    { direction: 'South', className: 'bottom-0 left-2 right-2 h-1 cursor-s-resize' },
    { direction: 'West', className: 'left-0 top-2 bottom-2 w-1 cursor-w-resize' },
    { direction: 'East', className: 'right-0 top-2 bottom-2 w-1 cursor-e-resize' },
    { direction: 'NorthWest', className: 'top-0 left-0 w-2 h-2 cursor-nw-resize' },
    { direction: 'NorthEast', className: 'top-0 right-0 w-2 h-2 cursor-ne-resize' },
    { direction: 'SouthWest', className: 'bottom-0 left-0 w-2 h-2 cursor-sw-resize' },
    { direction: 'SouthEast', className: 'bottom-0 right-0 w-2 h-2 cursor-se-resize' },
]

export function ResizeHandles() {
    const [maximized, setMaximized] = useState(false)

    useEffect(() => {
        let disposed = false
        const sync = () =>
            api.windowIsMaximized().then((m) => {
                if (!disposed) setMaximized(m)
            })
        sync()
        const off = api.onWindowResized(sync)
        return () => {
            disposed = true
            off()
        }
    }, [])

    if (maximized) return null

    return (
        <>
            {HANDLES.map(({ direction, className }) => (
                <div
                    key={direction}
                    data-window-resize={direction}
                    className={`fixed z-[70] pointer-events-auto ${className}`}
                    onMouseDown={(e) => {
                        if (e.button !== 0) return
                        e.preventDefault()
                        api.windowStartResizeDragging(direction)
                    }}
                />
            ))}
        </>
    )
}
