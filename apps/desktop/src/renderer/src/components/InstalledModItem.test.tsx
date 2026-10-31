// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { InstalledMod } from '../../../shared/types'

vi.mock('../api', () => ({ api: {} }))
vi.mock('./Tooltip', () => ({
    Tooltip: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('./PakViewerModal', () => ({ PakViewerModal: () => null }))
vi.mock('./ManageFilesModal', () => ({
    ManageFilesModal: ({ mods }: { mods: InstalledMod[] }) => (
        <div data-testid="manage-files">{mods.map((m) => m.uid).join(',')}</div>
    ),
}))
vi.mock('./ModCard', () => ({
    ModCard: (props: {
        locationNote?: string
        onUninstall: () => void
        onEnable: () => void
        onDisable: () => void
        onReinstall: () => void
    }) => (
        <div>
            <span data-testid="note">{props.locationNote ?? ''}</span>
            <button onClick={props.onUninstall}>uninstall</button>
            <button onClick={props.onEnable}>enable</button>
            <button onClick={props.onDisable}>disable</button>
            <button onClick={props.onReinstall}>reinstall</button>
        </div>
    ),
}))

import { InstalledModItem } from './InstalledModItem'
import { InstalledContext, type InstalledContextValue } from './InstalledContext'
import { identityKey } from '../hooks/installedUtils'

afterEach(cleanup)

function makeMod(overrides: Partial<InstalledMod>): InstalledMod {
    return {
        uid: 'mod',
        id: -7,
        name: 'Split mod',
        version: '1',
        filename: 'Split mod',
        enabled: true,
        installedAt: '',
        ...overrides,
    }
}

const pak = makeMod({ uid: 'pak', remoteId: '7', filename: 'split.pak' })
const lua = makeMod({ uid: 'lua', remoteId: '7', filename: 'SplitLua', location: 'ue4ss_mods' })

function renderItem(
    elsewhereByIdentity: InstalledContextValue['elsewhereByIdentity'],
    manageFilesKey: string | null = null,
    item: InstalledMod = pak,
    failedIds = new Set([-7]),
    activeGame: InstalledContextValue['activeGame'] = 'pd3'
) {
    const handlers = {
        handleUninstall: vi.fn(async () => {}),
        handleEnable: vi.fn(async () => {}),
        handleDisable: vi.fn(async () => {}),
        handleReinstall: vi.fn(async () => null),
    }
    const ctx = {
        modData: new Map(),
        failedIds,
        viewMode: 'grid',
        activeGame,
        gamePath: 'C:/game',
        isFiltering: false,
        visibleFolderIds: undefined,
        hiddenFolderIds: new Set<string>(),
        renderMods: [pak],
        folders: [],
        tabFolders: [],
        foldersEditable: true,
        elsewhereByIdentity,
        installed: [pak, lua],
        onRefreshInstalled: vi.fn(),
        onOpenDetail: vi.fn(),
        manageFilesKey,
        setManageFilesKey: vi.fn(),
        loadingMod: null,
        reinstallError: null,
        clearReinstallError: vi.fn(),
        handleIdentifyViaNexus: vi.fn(),
        requestMoveCrimeBossTarget: vi.fn(),
        reviewResource: vi.fn(),
        folderActions: {} as InstalledContextValue['folderActions'],
        dragItem: null,
        dropTarget: null,
        onModPointerDown: vi.fn(),
        onFolderPointerDown: vi.fn(),
        ...handlers,
    } satisfies InstalledContextValue
    render(
        <InstalledContext.Provider value={ctx}>
            <InstalledModItem mods={[item]} />
        </InstalledContext.Provider>
    )
    return handlers
}

describe('InstalledModItem across location tabs', () => {
    it('acts on the files the mod has on other tabs and names those tabs', () => {
        const handlers = renderItem(
            new Map([[identityKey(pak), { files: [lua], tabs: 'UE4SS mods' }]])
        )
        expect(screen.getByTestId('note').textContent).toBe('Also in UE4SS mods')
        for (const action of ['uninstall', 'enable', 'disable', 'reinstall']) {
            fireEvent.click(screen.getByText(action))
        }
        for (const handler of Object.values(handlers)) {
            expect(handler).toHaveBeenCalledWith([pak, lua])
        }
    })

    it('manages the files on every tab', () => {
        renderItem(
            new Map([[identityKey(pak), { files: [lua], tabs: 'UE4SS mods' }]]),
            identityKey(pak)
        )
        expect(screen.getByTestId('manage-files').textContent).toBe('pak,lua')
    })

    it('keeps a single-location mod to its own files', () => {
        const handlers = renderItem(new Map())
        expect(screen.getByTestId('note').textContent).toBe('')
        fireEvent.click(screen.getByText('disable'))
        expect(handlers.handleDisable).toHaveBeenCalledWith([pak])
    })
})

describe('InstalledModItem while metadata loads', () => {
    const waiting = (
        item: InstalledMod,
        activeGame: InstalledContextValue['activeGame'] = 'pd3'
    ) => {
        renderItem(new Map(), null, item, new Set(), activeGame)
        return screen.queryByTestId('note') === null
    }

    it('waits for a ModWorkshop id the metadata fetch requests', () => {
        expect(waiting(makeMod({ remoteId: '25629' }))).toBe(true)
    })

    it('shows local data for ids no fetch will ever request', () => {
        for (const remoteId of ['-3357105', '0', '4294967296', '12.5', 'abc']) {
            expect(waiting(makeMod({ remoteId })), remoteId).toBe(false)
            cleanup()
        }
    })

    it('shows local data in a game ModWorkshop does not list', () => {
        expect(waiting(makeMod({ remoteId: '25629' }), 'ron')).toBe(false)
    })
})
