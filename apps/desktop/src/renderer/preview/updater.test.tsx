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
    await act(() => emit('updater:update-progress', 47))
    expect(within(dialog).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('47')
    expect(within(dialog).getByText('47%')).toBeTruthy()
    expect(install).not.toHaveBeenCalled()
    await finishDownload()
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(within(dialog).queryByRole('progressbar')).toBeNull()
    expect(install).not.toHaveBeenCalled()
    expect(screen.getAllByRole('button', { name: 'Restart & Install', hidden: true })).toHaveLength(
        1
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restart & Install' }))
    expect(install).toHaveBeenCalledTimes(1)
})

test.each(['downloading', 'ready'])(
    'keeps the top-bar install action after Later during %s',
    async (phase) => {
        const { dialog, install, finishDownload } = await mountUpdate()
        fireEvent.click(within(dialog).getByRole('button', { name: 'Update' }))
        if (phase === 'ready') await finishDownload()
        fireEvent.click(within(dialog).getByRole('button', { name: 'Later' }))
        expect(screen.queryByRole('dialog')).toBeNull()
        if (phase === 'downloading') await finishDownload()
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(install).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Restart & Install' }))
        expect(install).toHaveBeenCalledTimes(1)
    }
)
