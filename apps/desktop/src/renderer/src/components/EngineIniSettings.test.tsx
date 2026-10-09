// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { api, type ConfigFileLocation } from '../api'
import { EngineIniSettings } from './EngineIniSettings'

vi.mock('../api', () => ({
    api: {
        getEngineIniLocation: vi.fn(),
        openEngineIni: vi.fn(),
        pickEngineIni: vi.fn(),
    },
}))

const configContext = { gamePath: 'G:/Games', onOpenGameSettings: vi.fn() }

const found: ConfigFileLocation = { status: 'found', path: 'G:/Config/Engine.ini' }

beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(api.getEngineIniLocation).mockResolvedValue(found)
})
afterEach(cleanup)

test('hands Open to the system editor without mounting a text editor', async () => {
    vi.mocked(api.openEngineIni).mockResolvedValue(null)
    render(<EngineIniSettings {...configContext} activeGame="cb" />)
    await screen.findByText('Engine.ini found.')
    expect(screen.getByText('G:/Config/Engine.ini')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Open' }).hasAttribute('disabled')).toBe(false)
    )
    expect(api.openEngineIni).toHaveBeenCalledExactlyOnceWith('cb')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
})

test('keeps the path, status and buttons in place while Open rechecks the file', async () => {
    let resolveCheck!: (location: ConfigFileLocation) => void
    vi.mocked(api.getEngineIniLocation)
        .mockResolvedValueOnce(found)
        .mockReturnValueOnce(
            new Promise((resolve) => {
                resolveCheck = resolve
            })
        )
    vi.mocked(api.openEngineIni).mockResolvedValue(null)
    render(<EngineIniSettings {...configContext} activeGame="pd3" />)
    await screen.findByText('Engine.ini found.')
    const open = screen.getByRole('button', { name: 'Open' })
    const browse = screen.getByRole('button', { name: 'Browse' })
    fireEvent.click(open)
    await waitFor(() => expect(api.getEngineIniLocation).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: 'Open' })).toBe(open)
    expect(screen.getByRole('button', { name: 'Browse' })).toBe(browse)
    expect(open.hasAttribute('disabled')).toBe(true)
    expect(browse.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(found.path)).toBeTruthy()
    expect(screen.getByText('Engine.ini found.')).toBeTruthy()
    expect(screen.queryByText('Checking the Engine.ini location...')).toBeNull()
    await act(async () => resolveCheck(found))
    await waitFor(() => expect(api.openEngineIni).toHaveBeenCalledExactlyOnceWith('pd3'))
    expect(open.hasAttribute('disabled')).toBe(false)
})

test('opens the selected configuration and leaves cancellation unchanged', async () => {
    vi.mocked(api.getEngineIniLocation)
        .mockResolvedValueOnce({ status: 'needsLocation' })
        .mockResolvedValueOnce(found)
    vi.mocked(api.pickEngineIni)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce('G:/Config/Engine.ini')
    vi.mocked(api.openEngineIni).mockResolvedValue(null)
    render(<EngineIniSettings {...configContext} activeGame="pd3" />)
    await screen.findByText(/cannot automatically locate Engine.ini/)
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }))
    await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Browse' }).hasAttribute('disabled')).toBe(false)
    )
    expect(api.openEngineIni).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }))
    await waitFor(() => expect(api.openEngineIni).toHaveBeenCalledExactlyOnceWith('pd3'))
    expect(api.pickEngineIni).toHaveBeenLastCalledWith('pd3', 'Choose Engine.ini')
})

test('shows a failed handoff and permits another attempt', async () => {
    vi.mocked(api.openEngineIni).mockRejectedValueOnce(new Error('Could not start the editor.'))
    render(<EngineIniSettings {...configContext} activeGame="pd3" />)
    await screen.findByText('Engine.ini found.')
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Could not start the editor.')
    expect(screen.getByRole('button', { name: 'Open' }).hasAttribute('disabled')).toBe(false)
})

test('does not retain the old path when a selected file cannot be checked', async () => {
    vi.mocked(api.getEngineIniLocation)
        .mockResolvedValueOnce(found)
        .mockRejectedValueOnce(new Error('Could not inspect the selected configuration'))
    vi.mocked(api.pickEngineIni).mockResolvedValueOnce('G:/Other/Engine.ini')
    render(<EngineIniSettings {...configContext} activeGame="pd3" />)
    await screen.findByText('Engine.ini found.')
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Could not inspect')
    expect(screen.queryByText(found.path)).toBeNull()
    expect(screen.queryByText('Engine.ini found.')).toBeNull()
    expect(screen.getByText('Modrex could not check the Engine.ini location.')).toBeTruthy()
    expect(api.openEngineIni).not.toHaveBeenCalled()
})

test('reports the missing file and checks again after it has been created', async () => {
    vi.mocked(api.getEngineIniLocation)
        .mockResolvedValueOnce({ status: 'missing', path: 'G:/Config/Engine.ini' })
        .mockResolvedValueOnce(found)
    render(<EngineIniSettings {...configContext} activeGame="pd3" />)
    await screen.findByText(/Engine.ini not found/)
    expect(screen.getByText('G:/Config/Engine.ini')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await screen.findByRole('button', { name: 'Open' })
    expect(api.openEngineIni).not.toHaveBeenCalled()
})

test('shows a failed check separately from a missing file and lets the user retry', async () => {
    vi.mocked(api.getEngineIniLocation).mockRejectedValueOnce(new Error('Permission denied'))
    render(<EngineIniSettings {...configContext} activeGame="pd3" />)
    expect((await screen.findByRole('alert')).textContent).toContain('Permission denied')
    expect(screen.getByText(/could not check the Engine.ini location/)).toBeTruthy()
    expect(screen.queryByText(/Engine.ini not found/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await screen.findByRole('button', { name: 'Open' })
})

test('does not open a file removed since the initial check', async () => {
    vi.mocked(api.getEngineIniLocation)
        .mockResolvedValueOnce(found)
        .mockResolvedValueOnce({ status: 'missing', path: found.path })
    render(<EngineIniSettings {...configContext} activeGame="pd3" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }))
    await screen.findByText(/Engine.ini not found/)
    expect(api.openEngineIni).not.toHaveBeenCalled()
})

test('discards a previous game check that finishes after switching games', async () => {
    let resolvePrevious!: (location: ConfigFileLocation) => void
    vi.mocked(api.getEngineIniLocation).mockReturnValueOnce(
        new Promise((resolve) => {
            resolvePrevious = resolve
        })
    )
    const view = render(<EngineIniSettings {...configContext} activeGame="pd3" />)
    view.rerender(<EngineIniSettings {...configContext} activeGame="cb" />)
    await screen.findByText('Engine.ini found.')
    await act(async () => resolvePrevious({ status: 'missing', path: 'G:/Old/Engine.ini' }))
    expect(screen.getByText('G:/Config/Engine.ini')).toBeTruthy()
    expect(screen.queryByText('G:/Old/Engine.ini')).toBeNull()
})

test('offers Game settings without file or recovery actions before a game folder is set', () => {
    render(<EngineIniSettings {...configContext} activeGame="pd3" gamePath={null} />)
    expect(screen.getByRole('status').textContent).toContain('Game folder not set')
    expect(api.getEngineIniLocation).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Browse' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Choose folder' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open recovery folder' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Game settings' }))
    expect(configContext.onOpenGameSettings).toHaveBeenCalledOnce()
})
