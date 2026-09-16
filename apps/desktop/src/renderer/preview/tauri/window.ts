const resizeListeners = new Set<() => void>()
window.addEventListener('resize', () => {
    for (const listener of resizeListeners) listener()
})

const previewWindow = {
    minimize: () => Promise.resolve(),
    toggleMaximize: () => Promise.resolve(),
    close: () => Promise.resolve(),
    isMaximized: () => Promise.resolve(true),
    startResizeDragging: () => Promise.resolve(),
    onResized(listener: () => void): Promise<() => void> {
        resizeListeners.add(listener)
        return Promise.resolve(() => {
            resizeListeners.delete(listener)
        })
    },
}

export function getCurrentWindow() {
    return previewWindow
}
