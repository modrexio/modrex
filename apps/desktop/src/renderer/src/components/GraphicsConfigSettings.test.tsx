// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { api, type ConfigFileLocation } from '../api'
import { GraphicsConfigSettings } from './GraphicsConfigSettings'

vi.mock('../api', () => ({
    api: {
        getGraphicsConfigLocation: vi.fn(),
        openGraphicsConfig: vi.fn(),
        pickGraphicsConfig: vi.fn(),
    },
}))

const filename = 'renderer_settings_dx11.xml'
const configContext = { gamePath: 'G:/Games', onOpenGameSettings: vi.fn() }

const found: ConfigFileLocation = {
    status: 'found',
    path: `G:/Config/${filename}`,
}

beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(api.getGraphicsConfigLocation).mockResolvedValue(found)
    vi.mocked(api.openGraphicsConfig).mockResolvedValue(null)
})
afterEach(cleanup)

test('opens the declared graphics file externally without preset recovery tools', async () => {
    render(<GraphicsConfigSettings {...configContext} activeGame="pd2" filename={filename} />)
    await screen.findByText(`${filename} found.`)
    expect(screen.getByText(found.path)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(api.openGraphicsConfig).toHaveBeenCalledExactlyOnceWith('pd2'))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open recovery folder' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Choose folder' })).toBeNull()
})

test('preserves a missing location on cancellation and opens an explicitly chosen file', async () => {
    vi.mocked(api.getGraphicsConfigLocation)
        .mockResolvedValueOnce({ status: 'missing', path: found.path })
        .mockResolvedValueOnce(found)
    vi.mocked(api.pickGraphicsConfig).mockResolvedValueOnce(null).mockResolvedValueOnce(found.path)
    render(<GraphicsConfigSettings {...configContext} activeGame="pd2" filename={filename} />)
    await screen.findByText(`${filename} not found.`)
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }))
    await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Browse' }).hasAttribute('disabled')).toBe(false)
    )
    expect(screen.getByText(found.path)).toBeTruthy()
    expect(api.getGraphicsConfigLocation).toHaveBeenCalledTimes(1)
    expect(api.openGraphicsConfig).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }))
    await waitFor(() => expect(api.openGraphicsConfig).toHaveBeenCalledExactlyOnceWith('pd2'))
    expect(api.pickGraphicsConfig).toHaveBeenLastCalledWith('pd2', `Choose ${filename}`)
    await screen.findByText(`${filename} found.`)
})

test('reports discovery failures separately from absent files and permits retry', async () => {
    vi.mocked(api.getGraphicsConfigLocation).mockRejectedValueOnce(new Error('Permission denied'))
    render(<GraphicsConfigSettings {...configContext} activeGame="pd2" filename={filename} />)
    expect((await screen.findByRole('alert')).textContent).toContain('Permission denied')
    expect(screen.getByText(`Modrex could not check the ${filename} location.`)).toBeTruthy()
    expect(screen.queryByText(/not found/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await screen.findByRole('button', { name: 'Open' })
})

test('keeps the discovered file available when a replacement selection is cancelled', async () => {
    vi.mocked(api.pickGraphicsConfig).mockResolvedValueOnce(null)
    render(<GraphicsConfigSettings {...configContext} activeGame="pd2" filename={filename} />)
    await screen.findByText(`${filename} found.`)
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }))
    await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Open' }).hasAttribute('disabled')).toBe(false)
    )
    expect(screen.getByText(found.path)).toBeTruthy()
    expect(api.getGraphicsConfigLocation).toHaveBeenCalledTimes(1)
    expect(api.openGraphicsConfig).not.toHaveBeenCalled()
})

test('does not open a picker result belonging to a previous game', async () => {
    let resolvePrevious!: (path: string) => void
    vi.mocked(api.getGraphicsConfigLocation)
        .mockResolvedValueOnce({ status: 'needsLocation' })
        .mockResolvedValueOnce({ status: 'found', path: `G:/RAID/${filename}` })
    vi.mocked(api.pickGraphicsConfig).mockReturnValueOnce(
        new Promise((resolve) => {
            resolvePrevious = resolve
        })
    )
    const view = render(
        <GraphicsConfigSettings {...configContext} activeGame="pd2" filename={filename} />
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Browse' }))
    view.rerender(
        <GraphicsConfigSettings {...configContext} activeGame="raid" filename={filename} />
    )
    await screen.findByText(`G:/RAID/${filename}`)
    await act(async () => resolvePrevious(found.path))
    expect(api.openGraphicsConfig).not.toHaveBeenCalled()
    expect(api.getGraphicsConfigLocation).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(found.path)).toBeNull()
})

test('discards a location failure from a previous installation context', async () => {
    let rejectPrevious!: (failure: Error) => void
    vi.mocked(api.getGraphicsConfigLocation).mockReturnValueOnce(
        new Promise((_resolve, reject) => {
            rejectPrevious = reject
        })
    )
    const view = render(
        <GraphicsConfigSettings
            {...configContext}
            key="pd2:old:steam"
            activeGame="pd2"
            filename={filename}
        />
    )
    view.rerender(
        <GraphicsConfigSettings
            {...configContext}
            key="pd2:new:manual"
            activeGame="pd2"
            filename={filename}
        />
    )
    await screen.findByText(`${filename} found.`)
    await act(async () => rejectPrevious(new Error('Old installation is unavailable')))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText(found.path)).toBeTruthy()
})

test('waits for game-folder discovery and checks the configuration when the folder becomes available', async () => {
    const view = render(
        <GraphicsConfigSettings
            {...configContext}
            activeGame="raid"
            filename={filename}
            gamePath={undefined}
        />
    )
    expect(screen.getByRole('status').textContent).toContain('Looking for the game folder')
    expect(api.getGraphicsConfigLocation).not.toHaveBeenCalled()
    expect(screen.queryByRole('button')).toBeNull()
    view.rerender(
        <GraphicsConfigSettings
            {...configContext}
            activeGame="raid"
            filename={filename}
            gamePath={null}
        />
    )
    expect(screen.getByRole('status').textContent).toContain('Game folder not set')
    expect(api.getGraphicsConfigLocation).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Browse' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Game settings' }))
    expect(configContext.onOpenGameSettings).toHaveBeenCalledOnce()
    view.rerender(
        <GraphicsConfigSettings {...configContext} activeGame="raid" filename={filename} />
    )
    await screen.findByText(`${filename} found.`)
    expect(api.getGraphicsConfigLocation).toHaveBeenCalledExactlyOnceWith('raid')
})

test('does not offer a repeated lookup when the configuration location must be chosen', async () => {
    vi.mocked(api.getGraphicsConfigLocation).mockResolvedValueOnce({ status: 'needsLocation' })
    render(<GraphicsConfigSettings {...configContext} activeGame="pd2" filename={filename} />)
    await screen.findByText(/Modrex cannot locate/)
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Browse' })).toBeTruthy()
})
