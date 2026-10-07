// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { api, type EngineIniLocation } from '../api'
import { EngineIniSettings } from './EngineIniSettings'

vi.mock('../api', () => ({
    api: {
        getEngineIniLocation: vi.fn(),
        openEngineIni: vi.fn(),
        pickEngineIni: vi.fn(),
        openDataFolder: vi.fn(),
    },
}))

const found: EngineIniLocation = { status: 'found', path: 'G:/Config/Engine.ini' }

beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(api.getEngineIniLocation).mockResolvedValue(found)
})
afterEach(cleanup)

test('hands Open INI to the system editor without mounting a text editor', async () => {
    vi.mocked(api.openEngineIni).mockResolvedValue(null)
    render(<EngineIniSettings activeGame="cb" />)
    await screen.findByText('Engine.ini found.')
    expect(screen.getByText('G:/Config/Engine.ini')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open INI' }))
    await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Open INI' }).hasAttribute('disabled')).toBe(
            false
        )
    )
    expect(api.openEngineIni).toHaveBeenCalledExactlyOnceWith('cb')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
})

test('opens the selected configuration and leaves cancellation unchanged', async () => {
    vi.mocked(api.getEngineIniLocation)
        .mockResolvedValueOnce({ status: 'needsLocation' })
        .mockResolvedValueOnce(found)
    vi.mocked(api.pickEngineIni)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce('G:/Config/Engine.ini')
    vi.mocked(api.openEngineIni).mockResolvedValue(null)
    render(<EngineIniSettings activeGame="pd3" />)
    await screen.findByText(/cannot automatically locate Engine.ini/)
    expect(screen.queryByRole('button', { name: 'Open INI' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Choose Engine.ini' }))
    await waitFor(() =>
        expect(
            screen.getByRole('button', { name: 'Choose Engine.ini' }).hasAttribute('disabled')
        ).toBe(false)
    )
    expect(api.openEngineIni).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Choose config folder' }))
    await waitFor(() => expect(api.openEngineIni).toHaveBeenCalledExactlyOnceWith('pd3'))
    expect(api.pickEngineIni).toHaveBeenLastCalledWith('pd3', 'Choose config folder', true)
})

test('shows a failed handoff and permits another attempt', async () => {
    vi.mocked(api.openEngineIni).mockRejectedValueOnce(new Error('Could not start the editor.'))
    render(<EngineIniSettings activeGame="pd3" />)
    await screen.findByText('Engine.ini found.')
    fireEvent.click(screen.getByRole('button', { name: 'Open INI' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Could not start the editor.')
    expect(screen.getByRole('button', { name: 'Open INI' }).hasAttribute('disabled')).toBe(false)
})

test('reports the missing file and checks again after it has been created', async () => {
    vi.mocked(api.getEngineIniLocation)
        .mockResolvedValueOnce({ status: 'missing', path: 'G:/Config/Engine.ini' })
        .mockResolvedValueOnce(found)
    render(<EngineIniSettings activeGame="pd3" />)
    await screen.findByText(/Engine.ini does not exist at this location/)
    expect(screen.getByText('G:/Config/Engine.ini')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open INI' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await screen.findByRole('button', { name: 'Open INI' })
    expect(api.openEngineIni).not.toHaveBeenCalled()
})

test('shows a failed check separately from a missing file and lets the user retry', async () => {
    vi.mocked(api.getEngineIniLocation).mockRejectedValueOnce(new Error('Permission denied'))
    render(<EngineIniSettings activeGame="pd3" />)
    expect((await screen.findByRole('alert')).textContent).toContain('Permission denied')
    expect(screen.getByText(/could not check the Engine.ini location/)).toBeTruthy()
    expect(screen.queryByText(/Engine.ini does not exist at this location/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open INI' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await screen.findByRole('button', { name: 'Open INI' })
})

test('does not open a file removed since the initial check', async () => {
    vi.mocked(api.getEngineIniLocation)
        .mockResolvedValueOnce(found)
        .mockResolvedValueOnce({ status: 'missing', path: found.path })
    render(<EngineIniSettings activeGame="pd3" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open INI' }))
    await screen.findByText(/Engine.ini does not exist at this location/)
    expect(api.openEngineIni).not.toHaveBeenCalled()
})

test('discards a previous game check that finishes after switching games', async () => {
    let resolvePrevious!: (location: EngineIniLocation) => void
    vi.mocked(api.getEngineIniLocation).mockReturnValueOnce(
        new Promise((resolve) => {
            resolvePrevious = resolve
        })
    )
    const view = render(<EngineIniSettings activeGame="pd3" />)
    view.rerender(<EngineIniSettings activeGame="cb" />)
    await screen.findByText('Engine.ini found.')
    await act(async () => resolvePrevious({ status: 'missing', path: 'G:/Old/Engine.ini' }))
    expect(screen.getByText('G:/Config/Engine.ini')).toBeTruthy()
    expect(screen.queryByText('G:/Old/Engine.ini')).toBeNull()
})
