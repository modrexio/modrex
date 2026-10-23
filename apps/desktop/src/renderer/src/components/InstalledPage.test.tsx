// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { GameId, InstalledMod } from '../../../shared/types'

const banner = vi.hoisted(() => ({ kind: '', dismiss: vi.fn() }))

vi.mock('../hooks/useModActions', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../hooks/useModActions')>()
    return {
        ...actual,
        useModActions: (...args: Parameters<typeof actual.useModActions>) => ({
            ...actual.useModActions(...args),
            modActionError: banner.kind === 'mod action' ? 'Mod action failed' : null,
            clearModActionError: banner.dismiss,
            reinstallError: banner.kind === 'reinstall' ? 'Reinstall failed' : null,
            clearReinstallError: banner.dismiss,
            identifyNexusResult:
                banner.kind === 'identify'
                    ? { kind: 'error' as const, message: 'Identification failed' }
                    : null,
            dismissIdentifyNexusResult: banner.dismiss,
        }),
    }
})
vi.mock('../hooks/useFolderActions', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../hooks/useFolderActions')>()
    return {
        ...actual,
        useFolderActions: (...args: Parameters<typeof actual.useFolderActions>) => ({
            ...actual.useFolderActions(...args),
            folderActionError: banner.kind === 'folder action' ? 'Folder action failed' : null,
            clearFolderActionError: banner.dismiss,
        }),
    }
})
vi.mock('../hooks/useDragDrop', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../hooks/useDragDrop')>()
    return {
        ...actual,
        useDragDrop: (...args: Parameters<typeof actual.useDragDrop>) => ({
            ...actual.useDragDrop(...args),
            dropError: banner.kind === 'drop' ? 'Drop failed' : null,
            clearDropError: banner.dismiss,
        }),
    }
})

vi.mock('../api')
vi.mock('../hooks/useModData', () => ({
    useModData: () => ({
        modData: new Map(),
        failedIds: new Set(),
        updatable: [],
        updateVersions: new Map(),
    }),
}))
vi.mock('../hooks/useAutoIdentifyNexusMods', () => ({ useAutoIdentifyNexusMods: vi.fn() }))
vi.mock('./Tooltip', () => ({
    Tooltip: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('./ScrollArea', () => ({
    ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('./InstalledModItem', () => ({ InstalledModItem: () => null }))

import { api, type ModFolderInfo } from '../api'
import { InstalledPage } from './InstalledPage'
import { t } from '../i18n'

beforeEach(() => {
    banner.kind = ''
    localStorage.clear()
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
    vi.mocked(api.listLoaders).mockResolvedValue([])
    vi.mocked(api.listModFolders).mockResolvedValue([
        { tag: 'mods', labelKey: 'mods', labelName: null },
    ])
    vi.mocked(api.checkPluginInstalls).mockResolvedValue({
        target: null,
        misplaced: [],
        rootDescriptor: null,
    })
})

afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.clearAllMocks()
})

function renderPage(activeGame: GameId = 'raid', installed: InstalledMod[] = []) {
    return render(
        <InstalledPage
            activeGame={activeGame}
            gamePath="C:/game"
            installed={installed}
            folders={[]}
            installedReady
            isActive
            onRefreshInstalled={vi.fn(async () => {})}
            onOpenDetail={vi.fn()}
        />
    )
}

describe('InstalledPage header', () => {
    it('gives New Folder an accessible name and only an icon on a single-location page', async () => {
        renderPage()
        await waitFor(() => expect(api.listModFolders).toHaveBeenCalledWith('raid'))
        const newFolder = screen.getByRole('button', { name: t('installed.newFolder') })
        expect(newFolder.textContent).toBe('')
        expect(newFolder.querySelector('svg')?.getAttribute('class')).toContain('w-3.5 h-3.5')
    })

    it('places open folder last after refresh and health on a single-location page', async () => {
        renderPage()
        await waitFor(() => expect(api.listModFolders).toHaveBeenCalledWith('raid'))
        const titleGroup = screen.getByRole('heading', {
            name: t('installed.title'),
        }).parentElement!
        const buttons = within(titleGroup).getAllByRole('button')
        expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
            t('installed.refresh'),
            t('installed.health.title'),
            t('installed.openFolder'),
        ])
        fireEvent.click(buttons[2]!)
        expect(api.openModsFolder).toHaveBeenCalledWith('raid')
    })

    it('keeps New Folder icon-only on the primary tab and hides it on other tabs', async () => {
        vi.mocked(api.listModFolders).mockResolvedValue([
            { tag: 'mods', labelKey: 'modkitMods', labelName: null },
            { tag: 'paks', labelKey: 'legacyPaks', labelName: null },
            { tag: 'ue4ss_mods', labelKey: 'loaderMods', labelName: 'UE4SS' },
        ] satisfies ModFolderInfo[])
        renderPage(
            'cb',
            ['paks', 'ue4ss_mods'].map((location, id) => ({
                uid: location,
                id,
                name: location,
                filename: location,
                version: '1',
                enabled: true,
                installedAt: '',
                location,
            }))
        )
        const tabs = await screen.findAllByRole('tab')
        const newFolder = screen.getByRole('button', { name: t('installed.newFolder') })
        expect(newFolder.textContent).toBe('')
        expect(newFolder.querySelector('svg')).toBeTruthy()
        const titleGroup = screen.getByRole('heading', {
            name: t('installed.title'),
        }).parentElement!
        expect(
            within(titleGroup)
                .getAllByRole('button')
                .map((button) => button.getAttribute('aria-label'))
        ).toEqual([t('installed.refresh'), t('installed.health.title')])
        fireEvent.click(tabs[1]!)
        expect(screen.queryByRole('button', { name: t('installed.newFolder') })).toBeNull()
        fireEvent.click(tabs[0]!)
        expect(screen.getByRole('button', { name: t('installed.newFolder') }).textContent).toBe('')
    })
})

describe('InstalledPage banner dismissal', () => {
    it('names and dismisses the location loading error button', async () => {
        vi.mocked(api.listModFolders).mockRejectedValue(new Error('Locations unavailable'))
        renderPage()
        const message = t('installed.tabs.loadFailed', { error: 'Error: Locations unavailable' })
        await screen.findByText(message)
        const dismiss = screen.getByRole('button', { name: t('common.dismiss') })
        fireEvent.click(dismiss)
        expect(screen.queryByText(message)).toBeNull()
    })

    it.each(['mod action', 'drop', 'folder action', 'reinstall', 'identify'])(
        'names the %s banner dismiss button and calls its handler',
        async (kind) => {
            banner.kind = kind
            renderPage()
            await waitFor(() => expect(api.listModFolders).toHaveBeenCalledWith('raid'))
            fireEvent.click(screen.getByRole('button', { name: t('common.dismiss') }))
            expect(banner.dismiss).toHaveBeenCalledOnce()
        }
    )
})
