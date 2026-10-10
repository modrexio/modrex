// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ConfigFileLocation } from '../api'
import { ConfigFileSettings } from './ConfigFileSettings'

const getLocation = vi.fn<(gameId: string) => Promise<ConfigFileLocation>>()
const pickFile = vi.fn<(gameId: string, title: string) => Promise<string | null>>()
const openFile = vi.fn<(gameId: string) => Promise<null>>()
const onOpenGameSettings = vi.fn()
const configContext = {
    isActive: true,
    filename: 'Engine.ini',
    title: 'Engine.ini',
    gamePath: 'G:/Games',
    onOpenGameSettings,
    getLocation,
    pickFile,
    openFile,
}
const found: ConfigFileLocation = { status: 'found', path: 'G:/Config/Engine.ini' }

beforeEach(() => {
    vi.resetAllMocks()
    getLocation.mockResolvedValue(found)
    openFile.mockResolvedValue(null)
})
afterEach(cleanup)

test('reserves the status and action layout during initial discovery', async () => {
    let resolveCheck!: (location: ConfigFileLocation) => void
    getLocation.mockReturnValueOnce(new Promise((resolve) => (resolveCheck = resolve)))
    render(<ConfigFileSettings {...configContext} activeGame="pd3" />)
    const statusRow = screen.getByRole('status')
    const open = screen.getByText('Open').closest('button')!
    const browse = screen.getByRole('button', { name: 'Browse' })
    const browseStyle = browse.className
    expect(open.hasAttribute('disabled')).toBe(true)
    expect(statusRow.textContent).toBe('Checking the Engine.ini location...')
    await act(async () => resolveCheck(found))
    expect(screen.getByRole('button', { name: 'Open' })).toBe(open)
    expect(screen.getByRole('status')).toBe(statusRow)
    expect(browse.className).toBe(browseStyle)
})

test('revalidates on activation without clearing the resolved location', async () => {
    let resolveCheck!: (location: ConfigFileLocation) => void
    const view = render(<ConfigFileSettings {...configContext} activeGame="pd3" />)
    await screen.findByText('Engine.ini found.')
    const open = screen.getByRole('button', { name: 'Open' })
    const browse = screen.getByRole('button', { name: 'Browse' })
    view.rerender(<ConfigFileSettings {...configContext} activeGame="pd3" isActive={false} />)
    getLocation.mockReturnValueOnce(new Promise((resolve) => (resolveCheck = resolve)))
    view.rerender(<ConfigFileSettings {...configContext} activeGame="pd3" />)
    expect(getLocation).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'Open' })).toBe(open)
    expect(screen.getByRole('button', { name: 'Browse' })).toBe(browse)
    expect(screen.getByText(found.path)).toBeTruthy()
    expect(screen.getByText('Engine.ini found.')).toBeTruthy()
    expect(screen.queryByText('Checking the Engine.ini location...')).toBeNull()
    await act(async () => resolveCheck({ status: 'missing', path: found.path }))
    expect(screen.getByText('Engine.ini not found.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()
})

test('reports an activation check failure instead of retaining a found status', async () => {
    const view = render(<ConfigFileSettings {...configContext} activeGame="pd3" />)
    await screen.findByText('Engine.ini found.')
    view.rerender(<ConfigFileSettings {...configContext} activeGame="pd3" isActive={false} />)
    getLocation.mockRejectedValueOnce(new Error('Permission denied'))
    view.rerender(<ConfigFileSettings {...configContext} activeGame="pd3" />)
    expect((await screen.findByRole('alert')).textContent).toContain('Permission denied')
    expect(screen.queryByText('Engine.ini found.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()
})

test('activation does not supersede an open file picker', async () => {
    let resolvePicker!: (path: string | null) => void
    pickFile.mockReturnValueOnce(new Promise((resolve) => (resolvePicker = resolve)))
    const view = render(<ConfigFileSettings {...configContext} activeGame="pd3" />)
    await screen.findByText('Engine.ini found.')
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }))
    view.rerender(<ConfigFileSettings {...configContext} activeGame="pd3" isActive={false} />)
    view.rerender(<ConfigFileSettings {...configContext} activeGame="pd3" />)
    expect(getLocation).toHaveBeenCalledTimes(1)
    await act(async () => resolvePicker(found.path))
    expect(openFile).toHaveBeenCalledExactlyOnceWith('pd3')
    expect(screen.getByRole('button', { name: 'Open' }).hasAttribute('disabled')).toBe(false)
})

test('rechecks on activation after cancelling a file picker', async () => {
    pickFile.mockResolvedValueOnce(null)
    const view = render(<ConfigFileSettings {...configContext} activeGame="pd3" />)
    await screen.findByText('Engine.ini found.')
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }))
    await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Browse' }).hasAttribute('disabled')).toBe(false)
    )
    view.rerender(<ConfigFileSettings {...configContext} activeGame="pd3" isActive={false} />)
    view.rerender(<ConfigFileSettings {...configContext} activeGame="pd3" />)
    expect(getLocation).toHaveBeenCalledTimes(2)
    expect(openFile).not.toHaveBeenCalled()
})

test('preserves a failed lookup when Browse is cancelled', async () => {
    getLocation.mockRejectedValueOnce(new Error('Permission denied'))
    pickFile.mockResolvedValueOnce(null)
    render(<ConfigFileSettings {...configContext} activeGame="pd3" />)
    const error = await screen.findByRole('alert')
    const browse = screen.getByRole('button', { name: 'Browse' })
    fireEvent.click(browse)
    await waitFor(() => expect(browse.hasAttribute('disabled')).toBe(false))
    expect(screen.getByRole('alert')).toBe(error)
    expect(screen.getByRole('status').textContent).toBe(
        'Modrex could not check the Engine.ini location.'
    )
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy()
    expect(screen.queryByText('Checking the Engine.ini location...')).toBeNull()
    expect(getLocation).toHaveBeenCalledTimes(1)
    expect(openFile).not.toHaveBeenCalled()
})

test('clears a previous installation while hidden and discovers the new path on activation', async () => {
    const view = render(<ConfigFileSettings {...configContext} activeGame="pd3" />)
    await screen.findByText('Engine.ini found.')
    view.rerender(
        <ConfigFileSettings
            {...configContext}
            activeGame="pd3"
            gamePath="G:/Other game"
            isActive={false}
        />
    )
    expect(screen.queryByText(found.path)).toBeNull()
    expect(getLocation).toHaveBeenCalledTimes(1)
    getLocation.mockResolvedValueOnce({ status: 'found', path: 'G:/Other/Engine.ini' })
    view.rerender(
        <ConfigFileSettings {...configContext} activeGame="pd3" gamePath="G:/Other game" />
    )
    await screen.findByText('G:/Other/Engine.ini')
    expect(getLocation).toHaveBeenCalledTimes(2)
})

test('keeps the path, status and buttons in place while Open rechecks the file', async () => {
    let resolveCheck!: (location: ConfigFileLocation) => void
    getLocation.mockResolvedValueOnce(found).mockReturnValueOnce(
        new Promise((resolve) => {
            resolveCheck = resolve
        })
    )
    render(<ConfigFileSettings {...configContext} activeGame="pd3" />)
    await screen.findByText('Engine.ini found.')
    const open = screen.getByRole('button', { name: 'Open' })
    const browse = screen.getByRole('button', { name: 'Browse' })
    fireEvent.click(open)
    await waitFor(() => expect(getLocation).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: 'Open' })).toBe(open)
    expect(screen.getByRole('button', { name: 'Browse' })).toBe(browse)
    expect(open.hasAttribute('disabled')).toBe(true)
    expect(browse.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(found.path)).toBeTruthy()
    expect(screen.getByText('Engine.ini found.')).toBeTruthy()
    expect(screen.queryByText('Checking the Engine.ini location...')).toBeNull()
    await act(async () => resolveCheck(found))
    await waitFor(() => expect(openFile).toHaveBeenCalledExactlyOnceWith('pd3'))
    expect(open.hasAttribute('disabled')).toBe(false)
})

test.each<ConfigFileLocation>([
    found,
    { status: 'missing', path: found.path },
    { status: 'needsLocation' },
])('preserves the $status location when Browse is cancelled', async (location) => {
    getLocation.mockResolvedValueOnce(location)
    pickFile.mockResolvedValueOnce(null)
    render(<ConfigFileSettings {...configContext} activeGame="pd3" />)
    const browse = await screen.findByRole('button', { name: 'Browse' })
    fireEvent.click(browse)
    await waitFor(() => expect(browse.hasAttribute('disabled')).toBe(false))
    expect(getLocation).toHaveBeenCalledTimes(1)
    expect(openFile).not.toHaveBeenCalled()
    if (location.status !== 'needsLocation') {
        expect(screen.getByText(location.path)).toBeTruthy()
        return
    }
    expect(screen.getByText(/cannot automatically locate Engine.ini/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
})

test('opens an explicitly chosen file using its localized picker title', async () => {
    getLocation.mockResolvedValueOnce({ status: 'needsLocation' })
    pickFile.mockResolvedValueOnce(found.path)
    render(<ConfigFileSettings {...configContext} activeGame="pd3" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Browse' }))
    await waitFor(() => expect(openFile).toHaveBeenCalledExactlyOnceWith('pd3'))
    expect(pickFile).toHaveBeenCalledExactlyOnceWith('pd3', 'Choose Engine.ini')
    expect(screen.getByText('Engine.ini found.')).toBeTruthy()
})

test('shows a failed editor handoff and permits another attempt', async () => {
    openFile.mockRejectedValueOnce(new Error('Could not start the editor.'))
    render(<ConfigFileSettings {...configContext} activeGame="pd3" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Could not start the editor.')
    const open = screen.getByRole('button', { name: 'Open' })
    expect(open.hasAttribute('disabled')).toBe(false)
    fireEvent.click(open)
    await waitFor(() => expect(openFile).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('alert')).toBeNull()
})

test('clears the found status when the Open recheck fails', async () => {
    getLocation.mockResolvedValueOnce(found).mockRejectedValueOnce(new Error('Permission denied'))
    render(<ConfigFileSettings {...configContext} activeGame="pd3" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Permission denied')
    expect(screen.queryByText('Engine.ini found.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()
    expect(openFile).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await screen.findByRole('button', { name: 'Open' })
})

test('clears the old path when an accepted selection cannot be checked', async () => {
    getLocation
        .mockResolvedValueOnce(found)
        .mockRejectedValueOnce(new Error('Could not inspect the selected configuration'))
    pickFile.mockResolvedValueOnce('G:/Other/Engine.ini')
    render(<ConfigFileSettings {...configContext} activeGame="pd3" />)
    await screen.findByText('Engine.ini found.')
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Could not inspect')
    expect(screen.queryByText(found.path)).toBeNull()
    expect(screen.queryByText('Engine.ini found.')).toBeNull()
    expect(screen.getByText('Modrex could not check the Engine.ini location.')).toBeTruthy()
    expect(openFile).not.toHaveBeenCalled()
})

test('reports a missing file and checks again after it has been created', async () => {
    getLocation.mockResolvedValueOnce({ status: 'missing', path: found.path })
    render(<ConfigFileSettings {...configContext} activeGame="pd3" />)
    await screen.findByText('Engine.ini not found.')
    expect(screen.getByText(found.path)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await screen.findByRole('button', { name: 'Open' })
    expect(openFile).not.toHaveBeenCalled()
})

test('reports lookup failures separately from absent files and permits retry', async () => {
    getLocation.mockRejectedValueOnce(new Error('Permission denied'))
    render(<ConfigFileSettings {...configContext} activeGame="pd3" />)
    expect((await screen.findByRole('alert')).textContent).toContain('Permission denied')
    expect(screen.getByText('Modrex could not check the Engine.ini location.')).toBeTruthy()
    expect(screen.queryByText('Engine.ini not found.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await screen.findByRole('button', { name: 'Open' })
})

test('does not open a file removed since the initial check', async () => {
    getLocation
        .mockResolvedValueOnce(found)
        .mockResolvedValueOnce({ status: 'missing', path: found.path })
    render(<ConfigFileSettings {...configContext} activeGame="pd3" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }))
    await screen.findByText('Engine.ini not found.')
    expect(openFile).not.toHaveBeenCalled()
})

test('discards a previous game lookup that finishes after switching games', async () => {
    let resolvePrevious!: (location: ConfigFileLocation) => void
    getLocation.mockReturnValueOnce(
        new Promise((resolve) => {
            resolvePrevious = resolve
        })
    )
    const view = render(<ConfigFileSettings {...configContext} activeGame="pd3" />)
    view.rerender(<ConfigFileSettings {...configContext} activeGame="cb" />)
    await screen.findByText('Engine.ini found.')
    await act(async () => resolvePrevious({ status: 'missing', path: 'G:/Old/Engine.ini' }))
    expect(screen.getByText(found.path)).toBeTruthy()
    expect(screen.queryByText('G:/Old/Engine.ini')).toBeNull()
})

test('does not open a picker result belonging to a previous game', async () => {
    let resolvePrevious!: (path: string) => void
    getLocation
        .mockResolvedValueOnce({ status: 'needsLocation' })
        .mockResolvedValueOnce({ status: 'found', path: 'G:/Other/Engine.ini' })
    pickFile.mockReturnValueOnce(
        new Promise((resolve) => {
            resolvePrevious = resolve
        })
    )
    const view = render(<ConfigFileSettings {...configContext} activeGame="pd3" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Browse' }))
    view.rerender(<ConfigFileSettings {...configContext} activeGame="cb" />)
    await screen.findByText('G:/Other/Engine.ini')
    await act(async () => resolvePrevious(found.path))
    expect(openFile).not.toHaveBeenCalled()
    expect(getLocation).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(found.path)).toBeNull()
})

test('discards a location failure from a previous installation context', async () => {
    let rejectPrevious!: (failure: Error) => void
    getLocation.mockReturnValueOnce(
        new Promise((_resolve, reject) => {
            rejectPrevious = reject
        })
    )
    const view = render(
        <ConfigFileSettings {...configContext} key="pd3:old:steam" activeGame="pd3" />
    )
    view.rerender(<ConfigFileSettings {...configContext} key="pd3:new:manual" activeGame="pd3" />)
    await screen.findByText('Engine.ini found.')
    await act(async () => rejectPrevious(new Error('Old installation is unavailable')))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText(found.path)).toBeTruthy()
})

test('waits for game-folder discovery and offers Game settings before a folder is set', async () => {
    const view = render(
        <ConfigFileSettings {...configContext} activeGame="pd3" gamePath={undefined} />
    )
    expect(screen.getByRole('status').textContent).toContain('Looking for the game folder')
    expect(getLocation).not.toHaveBeenCalled()
    expect(screen.queryByRole('button')).toBeNull()
    view.rerender(<ConfigFileSettings {...configContext} activeGame="pd3" gamePath={null} />)
    expect(screen.getByRole('status').textContent).toContain('Game folder not set')
    expect(getLocation).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Browse' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Game settings' }))
    expect(onOpenGameSettings).toHaveBeenCalledOnce()
    view.rerender(<ConfigFileSettings {...configContext} activeGame="pd3" />)
    await screen.findByText('Engine.ini found.')
    expect(getLocation).toHaveBeenCalledExactlyOnceWith('pd3')
})
