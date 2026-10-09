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
    render(<GraphicsConfigSettings activeGame="pd2" filename={filename} />)
    await screen.findByText(`${filename} found.`)
    expect(screen.getByText(found.path)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open graphics config' }))
    await waitFor(() => expect(api.openGraphicsConfig).toHaveBeenCalledExactlyOnceWith('pd2'))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open saved copies' })).toBeNull()
})

test('preserves a missing location on cancellation and opens an explicitly chosen folder file', async () => {
    vi.mocked(api.getGraphicsConfigLocation)
        .mockResolvedValueOnce({ status: 'missing', path: found.path })
        .mockResolvedValueOnce(found)
    vi.mocked(api.pickGraphicsConfig).mockResolvedValueOnce(null).mockResolvedValueOnce(found.path)
    render(<GraphicsConfigSettings activeGame="pd2" filename={filename} />)
    await screen.findByText(
        `${filename} was not found at this location. Check again after starting the game, or choose an existing file.`
    )
    expect(screen.queryByRole('button', { name: 'Open graphics config' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: `Choose ${filename}` }))
    await waitFor(() =>
        expect(
            screen.getByRole('button', { name: `Choose ${filename}` }).hasAttribute('disabled')
        ).toBe(false)
    )
    expect(screen.getByText(found.path)).toBeTruthy()
    expect(api.getGraphicsConfigLocation).toHaveBeenCalledTimes(1)
    expect(api.openGraphicsConfig).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Choose config folder' }))
    await waitFor(() => expect(api.openGraphicsConfig).toHaveBeenCalledExactlyOnceWith('pd2'))
    expect(api.pickGraphicsConfig).toHaveBeenLastCalledWith('pd2', 'Choose config folder', true)
    await screen.findByText(`${filename} found.`)
})

test('reports discovery failures separately from absent files and permits retry', async () => {
    vi.mocked(api.getGraphicsConfigLocation).mockRejectedValueOnce(new Error('Permission denied'))
    render(<GraphicsConfigSettings activeGame="pd2" filename={filename} />)
    expect((await screen.findByRole('alert')).textContent).toContain('Permission denied')
    expect(
        screen.getByText(
            `Modrex could not check the ${filename} location. Try again or choose the file.`
        )
    ).toBeTruthy()
    expect(screen.queryByText(/was not found at this location/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await screen.findByRole('button', { name: 'Open graphics config' })
})

test('keeps the discovered file available when a replacement selection is cancelled', async () => {
    vi.mocked(api.pickGraphicsConfig).mockResolvedValueOnce(null)
    render(<GraphicsConfigSettings activeGame="pd2" filename={filename} />)
    await screen.findByText(`${filename} found.`)
    fireEvent.click(screen.getByText('File location'))
    fireEvent.click(screen.getByRole('button', { name: `Choose ${filename}` }))
    await waitFor(() =>
        expect(
            screen.getByRole('button', { name: 'Open graphics config' }).hasAttribute('disabled')
        ).toBe(false)
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
    const view = render(<GraphicsConfigSettings activeGame="pd2" filename={filename} />)
    fireEvent.click(await screen.findByRole('button', { name: `Choose ${filename}` }))
    view.rerender(<GraphicsConfigSettings activeGame="raid" filename={filename} />)
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
        <GraphicsConfigSettings key="pd2:old:steam" activeGame="pd2" filename={filename} />
    )
    view.rerender(
        <GraphicsConfigSettings key="pd2:new:manual" activeGame="pd2" filename={filename} />
    )
    await screen.findByText(`${filename} found.`)
    await act(async () => rejectPrevious(new Error('Old installation is unavailable')))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText(found.path)).toBeTruthy()
})
