// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { api } from '../api'
import { EngineIniSettings } from './EngineIniSettings'
import { GraphicsConfigSettings } from './GraphicsConfigSettings'

vi.mock('../api', () => ({
    api: {
        getEngineIniLocation: vi.fn(),
        openEngineIni: vi.fn(),
        pickEngineIni: vi.fn(),
        getGraphicsConfigLocation: vi.fn(),
        openGraphicsConfig: vi.fn(),
        pickGraphicsConfig: vi.fn(),
    },
}))
const context = { isActive: true, gamePath: 'G:/Games', onOpenGameSettings: vi.fn() }
const filename = 'renderer_settings_dx11.xml'
const wrappers = [
    {
        gameId: 'cb',
        filename: 'Engine.ini',
        getLocation: api.getEngineIniLocation,
        openFile: api.openEngineIni,
        pickFile: api.pickEngineIni,
        render: () => <EngineIniSettings {...context} activeGame="cb" />,
    },
    {
        gameId: 'pd2',
        filename,
        getLocation: api.getGraphicsConfigLocation,
        openFile: api.openGraphicsConfig,
        pickFile: api.pickGraphicsConfig,
        render: () => <GraphicsConfigSettings {...context} activeGame="pd2" filename={filename} />,
    },
]
beforeEach(() => vi.resetAllMocks())
afterEach(cleanup)

test.each(wrappers)(
    'wires $filename to its discovery, editor and file picker commands',
    async (wrapper) => {
        const path = `G:/Config/${wrapper.filename}`
        vi.mocked(wrapper.getLocation).mockResolvedValue({ status: 'found', path })
        vi.mocked(wrapper.openFile).mockResolvedValue(null)
        vi.mocked(wrapper.pickFile).mockResolvedValue(null)
        render(wrapper.render())
        await screen.findByText(`${wrapper.filename} found.`)
        expect(screen.getByText(path)).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: 'Open' }))
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Open' }).hasAttribute('disabled')).toBe(
                false
            )
        )
        expect(wrapper.openFile).toHaveBeenCalledExactlyOnceWith(wrapper.gameId)
        expect(wrapper.getLocation).toHaveBeenCalledWith(wrapper.gameId)
        fireEvent.click(screen.getByRole('button', { name: 'Browse' }))
        await waitFor(() =>
            expect(wrapper.pickFile).toHaveBeenCalledExactlyOnceWith(
                wrapper.gameId,
                `Choose ${wrapper.filename}`
            )
        )
        expect(screen.queryByRole('textbox')).toBeNull()
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(screen.queryByRole('button', { name: 'Open recovery folder' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Choose folder' })).toBeNull()
    }
)
