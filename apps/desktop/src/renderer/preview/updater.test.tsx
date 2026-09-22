import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

beforeEach(() => {
    vi.resetModules()
    window.history.replaceState({}, '', '/')
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
    })
})

afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

async function mountUpdate() {
    const { api } = await import('../src/api')
    const { emit } = await import('./tauri/event')
    let resolveDownload!: () => void
    const pending = new Promise<void>((resolve) => {
        resolveDownload = resolve
    })
    const download = vi.spyOn(api, 'download').mockReturnValue(pending)
    const install = vi.spyOn(api, 'installUpdate').mockResolvedValue()
    const { default: App } = await import('../src/App')
    render(<App />)
    await screen.findByRole('heading', { name: 'Games' })
    await act(() =>
        emit('updater:update-available', {
            version: '0.15.1',
            strategy: 'manual',
            body: 'Release notes',
            releaseUrl: 'https://github.com/modrexio/modrex/releases/tag/v0.15.1',
        })
    )
    const dialog = screen.getByRole('dialog')
    async function finishDownload() {
        await act(async () => {
            await emit('updater:update-ready')
            resolveDownload()
            await pending
        })
    }
    return { dialog, download, install, emit, finishDownload }
}

test('keeps the same update popup through download until the user chooses installation', async () => {
    const { dialog, download, install, emit, finishDownload } = await mountUpdate()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update' }))
    expect(download).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(within(dialog).queryByRole('button', { name: 'Update' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Later' })).toBeNull()
    await act(() => emit('updater:update-progress', 47))
    expect(within(dialog).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('47')
    expect(within(dialog).getByText('47%')).toBeTruthy()
    expect(install).not.toHaveBeenCalled()
    await finishDownload()
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(within(dialog).queryByRole('progressbar')).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Later' })).toBeNull()
    expect(install).not.toHaveBeenCalled()
    expect(screen.getAllByRole('button', { name: 'Restart & Install', hidden: true })).toHaveLength(
        1
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restart & Install' }))
    expect(install).toHaveBeenCalledTimes(1)
})

test.each(['downloading', 'ready'])(
    'keeps the top-bar install action after closing the popup during %s',
    async (phase) => {
        const { dialog, install, finishDownload } = await mountUpdate()
        fireEvent.click(within(dialog).getByRole('button', { name: 'Update' }))
        if (phase === 'ready') await finishDownload()
        fireEvent.click(within(dialog).getByRole('button', { name: '' }))
        expect(screen.queryByRole('dialog')).toBeNull()
        if (phase === 'downloading') await finishDownload()
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(install).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Restart & Install' }))
        expect(install).toHaveBeenCalledTimes(1)
    }
)

test.each(['available', 'downloading', 'ready'])(
    'keeps the %s update popup open when restoring the window',
    async (phase) => {
        const { dialog, finishDownload } = await mountUpdate()
        if (phase !== 'available')
            fireEvent.click(within(dialog).getByRole('button', { name: 'Update' }))
        if (phase === 'ready') await finishDownload()
        const { api } = await import('../src/api')
        const restore = vi.spyOn(api, 'windowToggleMaximize').mockResolvedValue()
        const button = screen.getByRole('button', { name: 'Restore', hidden: true })
        await act(async () => {
            fireEvent(button, new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
            fireEvent.click(button)
            fireEvent(window, new Event('resize'))
            await new Promise((resolve) => setTimeout(resolve, 0))
        })
        expect(restore).toHaveBeenCalledTimes(1)
        expect(screen.queryByRole('dialog')).toBe(dialog)
    }
)

test('keeps the update popup open when dragging a Linux resize handle', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Linux')
    const { api } = await import('../src/api')
    vi.spyOn(api, 'windowIsMaximized').mockResolvedValue(false)
    const resize = vi.spyOn(api, 'windowStartResizeDragging').mockResolvedValue()
    const { dialog } = await mountUpdate()
    const handle = document.querySelector('[data-window-resize="East"]')!
    expect(handle.classList.contains('pointer-events-auto')).toBe(true)
    await act(async () => {
        fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
        fireEvent.mouseDown(handle, { button: 0 })
        fireEvent(window, new Event('resize'))
        fireEvent.click(handle)
        await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(resize).toHaveBeenCalledExactlyOnceWith('East')
    expect(screen.queryByRole('dialog')).toBe(dialog)
})

test.each(['outside click', 'Escape', 'close button'])(
    'still dismisses the update popup on %s',
    async (action) => {
        const { dialog, install } = await mountUpdate()
        await act(async () => {
            if (action === 'outside click') {
                fireEvent(
                    document.body,
                    new MouseEvent('pointerdown', { bubbles: true, button: 0 })
                )
                fireEvent.click(document.body)
            }
            if (action === 'Escape') fireEvent.keyDown(dialog, { key: 'Escape' })
            if (action === 'close button')
                fireEvent.click(within(dialog).getByRole('button', { name: '' }))
            await new Promise((resolve) => setTimeout(resolve, 0))
        })
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(install).not.toHaveBeenCalled()
    }
)
