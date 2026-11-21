// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ProfileList, ProfileSharePreview } from '../api'
import type { Profiles } from '../hooks/useProfiles'

const sources = vi.hoisted(() => ({ workshop: true }))

vi.mock('../api')
vi.mock('../sources', () => ({
    hasSource: (_game: string, source: string) => source !== 'modworkshop' || sources.workshop,
    SOURCE_LABELS: { modworkshop: 'ModWorkshop', nexus: 'Nexus Mods' },
}))

import { api } from '../api'
import { ImportProfileDialog, PendingSharedDialog, ShareProfileDialog } from './ProfileShareDialogs'
import { TooltipProvider } from './Tooltip'

const list: ProfileList = {
    profiles: [{ id: 'p1', name: 'Heists' }],
    active: 'p1',
    unfinishedSwitch: null,
    loaders: [],
    pending: [
        {
            memberKey: 2,
            action: 'nexusDownload',
            source: 'nexus',
            modId: 27,
            fileId: 89,
            installedName: 'Nexus HUD.pak',
            reason: 'Waiting for a Nexus download',
            url: 'https://www.nexusmods.com/payday3/mods/27?tab=files&file_id=89&nmm=1',
        },
        {
            memberKey: 3,
            action: 'openMod',
            source: 'modworkshop',
            modId: 42,
            fileId: 70,
            installedName: 'Skins',
            reason: 'Choose a file from the archive',
            url: 'https://modworkshop.net/mod/42',
        },
        {
            memberKey: 4,
            action: 'tryAgain',
            source: 'modworkshop',
            modId: 43,
            fileId: 71,
            installedName: 'Stopped.pak',
            reason: 'The import stopped before this mod was installed',
            url: 'https://modworkshop.net/mod/43',
        },
        {
            memberKey: 5,
            action: 'chooseFile',
            source: 'nexus',
            modId: 28,
            fileId: null,
            installedName: 'Page only.pak',
            reason: 'Choose a file',
            url: 'https://www.nexusmods.com/payday3/mods/28?tab=files',
        },
    ],
}

function profiles(overrides: Partial<Profiles> = {}): Profiles {
    return {
        list,
        switching: null,
        error: null,
        clearError: vi.fn(),
        switchTo: vi.fn(),
        create: vi.fn(),
        rename: vi.fn(),
        remove: vi.fn(),
        dismissPending: vi.fn().mockResolvedValue(undefined),
        refresh: vi.fn().mockResolvedValue(undefined),
        pendingShown: false,
        showPending: vi.fn(),
        ...overrides,
    }
}

const file = (id: number, name: string) => ({ id, name, label: null, version: '1.4', size: 1024 })

const preview: ProfileSharePreview = {
    profileName: 'Shared',
    rows: [
        {
            memberKey: 1,
            source: 'modworkshop',
            modId: 42,
            installedName: 'HUD.pak',
            sharedVersion: '1.2',
            installVersion: '1.4',
            resolution: { status: 'ready', file: file(7, 'HUD'), foundByName: false },
        },
        {
            memberKey: 2,
            source: 'nexus',
            modId: 27,
            installedName: 'Nexus HUD.pak',
            sharedVersion: '2.0',
            installVersion: '2.0',
            resolution: { status: 'nexusDownload', file: file(89, 'Nexus HUD') },
        },
        {
            memberKey: 3,
            source: 'modworkshop',
            modId: 43,
            installedName: 'Skins',
            sharedVersion: null,
            installVersion: null,
            resolution: { status: 'needsChoice', candidates: [file(8, 'Steam'), file(9, 'Xbox')] },
        },
        {
            memberKey: 4,
            source: 'modworkshop',
            modId: 44,
            installedName: 'Gone.pak',
            sharedVersion: null,
            installVersion: null,
            resolution: { status: 'unavailable', reason: 'The mod is missing or hidden' },
        },
    ],
    loaders: [],
    totals: {
        ready: 1,
        nexusDownload: 1,
        needsChoice: 1,
        unavailable: 1,
        lookupFailed: 0,
        nexusSignInRequired: 0,
        knownDownloadBytes: 1024,
        nexusDownloadsNeeded: 1,
    },
    failedSources: [],
}

function wrap(node: React.ReactNode) {
    render(<TooltipProvider>{node}</TooltipProvider>)
}

beforeEach(() => {
    sources.workshop = true
    vi.mocked(api.onProfileShareProgress).mockReturnValue(() => {})
    vi.mocked(api.onProfileImportProgress).mockReturnValue(() => {})
    vi.mocked(api.requestNexusDownload).mockResolvedValue(undefined)
    vi.mocked(api.openExternal).mockResolvedValue(undefined)
})
afterEach(() => {
    cleanup()
    vi.clearAllMocks()
})

describe('ShareProfileDialog', () => {
    it('says how many local mods are left out and copies the code', async () => {
        vi.mocked(api.exportProfileShare).mockResolvedValue({
            fileText: '{}',
            pasteCode: 'MRX:abc',
            leftOut: 2,
        })
        const writeText = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
        wrap(
            <ShareProfileDialog
                gameId="pd3"
                gamePath="C:/game"
                profile={{ id: 'p1', name: 'Heists' }}
                onClose={vi.fn()}
            />
        )
        await screen.findByText(/2 mods installed by hand are left out/)
        // The code is shown, so the user sees what they copy.
        expect(screen.getByDisplayValue('MRX:abc')).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
        await screen.findByRole('button', { name: 'Code copied' })
        expect(writeText).toHaveBeenCalledWith('MRX:abc')
    })
})

describe('ImportProfileDialog', () => {
    function check(state = profiles()) {
        wrap(
            <ImportProfileDialog
                gameId="pd3"
                gamePath="C:/game"
                profiles={state}
                onClose={vi.fn()}
            />
        )
        fireEvent.change(screen.getByLabelText('Profile code'), { target: { value: 'MRX:abc' } })
        fireEvent.click(screen.getByRole('button', { name: 'Check mods' }))
    }

    it('names the game a share for another game belongs to', async () => {
        vi.mocked(api.parseProfileShare).mockResolvedValue({ gameId: 'pd2' } as never)
        check()
        await screen.findByText('This profile is for PAYDAY 2. Open that game to import it.')
        expect(api.previewProfileShare).not.toHaveBeenCalled()
    })

    it('lists each mod with its status and offers Nexus mods as an option', async () => {
        vi.mocked(api.parseProfileShare).mockResolvedValue({
            gameId: 'pd3',
            members: [],
        } as never)
        vi.mocked(api.previewProfileShare).mockResolvedValue(preview)
        check()
        await screen.findByText('HUD.pak')
        expect(screen.getByText(/Shared 1\.2, installs 1\.4/)).toBeTruthy()
        expect(screen.getByText('Download from Nexus')).toBeTruthy()
        expect(screen.getAllByText('Choose a file').length).toBeGreaterThan(0)
        expect(screen.getByText('The mod is missing or hidden')).toBeTruthy()
        expect(
            screen.getByLabelText('Include Nexus mods (1, one click on nexusmods.com)')
        ).toBeTruthy()
    })

    it('hides the Nexus option for a game whose only source is Nexus', async () => {
        sources.workshop = false
        vi.mocked(api.parseProfileShare).mockResolvedValue({
            gameId: 'pd3',
            members: [],
        } as never)
        vi.mocked(api.previewProfileShare).mockResolvedValue(preview)
        check()
        await screen.findByText('HUD.pak')
        expect(screen.queryByText(/Include Nexus mods/)).toBeNull()
    })

    it('imports under the chosen name and reports what installed', async () => {
        vi.mocked(api.parseProfileShare).mockResolvedValue({
            gameId: 'pd3',
            members: [],
        } as never)
        vi.mocked(api.previewProfileShare).mockResolvedValue(preview)
        vi.mocked(api.importProfileShare).mockResolvedValue({
            profileId: 'p9',
            members: [
                { memberKey: 1, outcome: { status: 'installed', installId: 'a' } },
                { memberKey: 2, outcome: { status: 'pending', reason: 'Waiting' } },
                { memberKey: 3, outcome: { status: 'pending', reason: 'Choose' } },
                { memberKey: 4, outcome: { status: 'pending', reason: 'Gone' } },
            ],
            loaders: {},
            newerVersions: 1,
        })
        const state = profiles()
        check(state)
        fireEvent.change(await screen.findByLabelText('New profile name'), {
            target: { value: 'Friend' },
        })
        fireEvent.click(screen.getByRole('button', { name: 'Download all mods' }))
        await screen.findByText(/1 of 4 mods installed/)
        expect(api.importProfileShare).toHaveBeenCalledWith(
            'MRX:abc',
            'pd3',
            'C:/game',
            'Friend',
            {}
        )
        expect(state.refresh).toHaveBeenCalled()
        expect(screen.getByText(/1 of these mods has a newer version/)).toBeTruthy()
        // The Nexus mods are included, so the first waiting one opens on nexusmods.com.
        await waitFor(() =>
            expect(api.requestNexusDownload).toHaveBeenCalledWith(
                'pd3',
                27,
                list.pending[0]!.url,
                89
            )
        )
    })
})

describe('PendingSharedDialog', () => {
    it('offers each waiting mod the action it needs', async () => {
        vi.mocked(api.installPendingShareMember).mockResolvedValue({
            status: 'installed',
            installId: 'x',
        })
        vi.mocked(api.pendingShareMemberFiles).mockResolvedValue([file(91, 'Main')])
        const state = profiles()
        const onOpenMod = vi.fn()
        const onClose = vi.fn()
        wrap(
            <PendingSharedDialog
                gameId="pd3"
                gamePath="C:/game"
                profiles={state}
                onOpenMod={onOpenMod}
                onClose={onClose}
            />
        )
        fireEvent.click(screen.getByRole('button', { name: 'Open on Nexus' }))
        await waitFor(() =>
            expect(api.requestNexusDownload).toHaveBeenCalledWith(
                'pd3',
                27,
                list.pending[0]!.url,
                89
            )
        )
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
        await waitFor(() =>
            expect(api.installPendingShareMember).toHaveBeenCalledWith('pd3', 'C:/game', 4)
        )
        await waitFor(() => expect(state.refresh).toHaveBeenCalled())
        // A mod whose file still has to be chosen loads its files for the picker.
        expect(api.pendingShareMemberFiles).toHaveBeenCalledWith('pd3', 'C:/game', 5)
        fireEvent.click(screen.getByRole('button', { name: 'Dismiss Skins' }))
        expect(state.dismissPending).toHaveBeenCalledWith(3)
        fireEvent.click(screen.getByRole('button', { name: 'Open mod page' }))
        expect(onClose).toHaveBeenCalled()
        expect(onOpenMod).toHaveBeenCalledWith(42)
    })
})
