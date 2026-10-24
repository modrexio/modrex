// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { InstalledMod, Mod, ModSummary } from '../../../shared/types'

const mockNexusGetModDetail = vi.fn()
const mockFileUpdate = vi.fn()
const mockGetMod = vi.fn()
const mockListModFiles = vi.fn()
const mockListModLinks = vi.fn()
const mockListMods = vi.fn()
const mockVersions = vi.fn()

// nexusModCache subscribes to this at module load to track Nexus sign-ins. Capturing the
// callback is what lets the re-authorization test below fire a real sign-in. Hoisted
// because the subscription runs while the mocked module is first imported, before a
// plain const at this scope would have initialized.
const { signedInListeners } = vi.hoisted(() => ({ signedInListeners: [] as (() => void)[] }))

function emitNexusSignedIn() {
    for (const listener of signedInListeners) listener()
}

vi.mock('../api', () => ({
    api: {
        nexusGetModDetail: (...args: unknown[]) => mockNexusGetModDetail(...args),
        nexusCheckInstalled: async (
            gameId: string,
            modId: number,
            files: { fileId: number; version: string }[]
        ) => ({
            detail: await mockNexusGetModDetail(gameId, modId),
            files: files.map((file) => ({ fileId: file.fileId, update: mockFileUpdate(file) })),
        }),
        getMod: (...args: unknown[]) => mockGetMod(...args),
        listModFiles: (...args: unknown[]) => mockListModFiles(...args),
        listModLinks: (...args: unknown[]) => mockListModLinks(...args),
        listMods: (...args: unknown[]) => mockListMods(...args),
        getModVersions: (...args: unknown[]) => mockVersions(...args),
        onNexusOAuthSignedIn: (callback: () => void) => {
            signedInListeners.push(callback)
            return () => {}
        },
    },
}))
vi.mock('../thumbnailCache', () => ({
    getLocalImage: vi.fn().mockResolvedValue('thumb://x'),
}))

import { useModData } from './useModData'

function makeNexusInstall(id: number, remoteId: string, version: string): InstalledMod {
    return {
        uid: `nexus:${remoteId}`,
        id,
        name: 'Unmask Mod',
        version,
        filename: 'unmask.pak',
        enabled: true,
        installedAt: '2024-01-01T00:00:00Z',
        source: 'nexus',
        remoteId,
    }
}

function makeWorkshopInstall(id: number, version: string): InstalledMod {
    return {
        uid: `${id}`,
        id,
        // InstalledMod.id is an opaque local key even for modworkshop mods now;
        // useModData reads remoteId to know the real id to fetch/refresh against.
        remoteId: String(id),
        name: 'Workshop Mod',
        version,
        filename: 'workshop.pak',
        enabled: true,
        installedAt: '2024-01-01T00:00:00Z',
    }
}

function makeNexusDetail(id: number, version: string): Mod {
    return {
        id,
        name: 'Unmask Mod',
        desc: '',
        short_desc: '',
        version,
        legacy_markup: false,
        downloads: 0,
        likes: 0,
        views: 0,
        published_at: '',
        bumped_at: '',
        category_id: 0,
        has_download: true,
        disable_mod_managers: null,
        download_type: null,
        thumbnail: null,
        download: null,
        user: { id: null, name: '', donation_url: null, avatar: null, avatar_has_thumb: null },
        download_id: null,
        files_are_versions: null,
        changelog: null,
        instructions: null,
        license: null,
        repo_url: null,
        donation: null,
        banner: null,
        images: [],
        dependencies: [],
        instructs_template: null,
        tags: [],
        members: [],
    }
}

function makeWorkshopSummary(id: number): ModSummary {
    return {
        id,
        name: 'Workshop Mod',
        desc: '',
        short_desc: '',
        legacy_markup: false,
        downloads: 0,
        likes: 0,
        views: 0,
        published_at: '',
        bumped_at: '',
        category_id: 0,
        has_download: true,
        disable_mod_managers: null,
        download_type: null,
        thumbnail: null,
        user: { id: null, name: '', donation_url: null, avatar: null, avatar_has_thumb: null },
    }
}

beforeEach(() => {
    mockNexusGetModDetail.mockReset()
    mockFileUpdate.mockReset()
    mockGetMod.mockReset()
    mockListModFiles.mockReset()
    mockListModLinks.mockReset()
    mockListMods.mockReset()
    mockVersions.mockImplementation(async (ids: number[]) =>
        ids.map((id) => ({ id, status: 'known', version: '3.0' }))
    )
})

describe('useModData end-to-end with a real installed Nexus mod', () => {
    it('flags an installed Nexus mod as updatable when Nexus reports a newer version', async () => {
        const installed = [makeNexusInstall(-216, '216', '1.0.0')]
        mockNexusGetModDetail.mockResolvedValue(makeNexusDetail(216, '1.1.0'))

        const { result } = renderHook(() => useModData(installed, 853, 'pd3'))

        await waitFor(() => expect(result.current.updatable).toHaveLength(1))
        expect(mockNexusGetModDetail).toHaveBeenCalledWith('pd3', 216)
        expect(mockListMods).not.toHaveBeenCalled()
        expect(result.current.updatable[0]).toBe(installed[0])
        expect(result.current.updateVersions.get(-216)).toBe('1.1.0')
    })

    it('does not flag an installed Nexus mod as updatable when the version already matches', async () => {
        // A distinct mod id from the other tests in this file: nexusModCache's cache is
        // module-level state that outlives a single test, so reusing an id another test
        // already resolved would read that test's cached version instead of calling the
        // mock this test configures.
        const installed = [makeNexusInstall(-300, '300', '1.1.0')]
        mockNexusGetModDetail.mockResolvedValue(makeNexusDetail(300, '1.1.0'))

        const { result } = renderHook(() => useModData(installed, 853, 'pd3'))

        await waitFor(() => expect(result.current.modData.get(-300)).toBeDefined())
        expect(result.current.updatable).toEqual([])
    })

    it('uses a fresh cached Nexus detail as update authority', async () => {
        const first = [makeNexusInstall(-700, '700', '1.0.0')]
        mockNexusGetModDetail.mockResolvedValue(makeNexusDetail(700, '1.1.0'))
        const initial = renderHook(() => useModData(first, 853, 'pd3'))
        await waitFor(() => expect(initial.result.current.updatable).toHaveLength(1))
        initial.unmount()

        mockNexusGetModDetail.mockClear()
        const cached = renderHook(() => useModData(first, 853, 'pd3'))
        await waitFor(() => expect(cached.result.current.updatable).toHaveLength(1))
        expect(mockNexusGetModDetail).not.toHaveBeenCalled()
    })

    it('returns cached Workshop and Nexus metadata and Nexus versions on the first render', async () => {
        const installed = [makeWorkshopInstall(59001, '1.0'), makeNexusInstall(-701, '701', '1.0')]
        const workshop = makeWorkshopSummary(59001)
        const nexus = makeNexusDetail(701, '2.0')
        mockListMods.mockResolvedValue({ data: [workshop], meta: {} })
        mockNexusGetModDetail.mockResolvedValue(nexus)
        const initial = renderHook(() => useModData(installed, 853, 'pd3'))
        await waitFor(() => expect(initial.result.current.modData.size).toBe(2))
        initial.unmount()
        mockListMods.mockClear()
        mockNexusGetModDetail.mockClear()

        const renders: ReturnType<typeof useModData>[] = []
        renderHook(() => {
            const data = useModData(installed, 853, 'pd3')
            renders.push(data)
            return data
        })
        expect(renders[0]!.modData.get(59001)).toEqual(workshop)
        expect(renders[0]!.modData.get(-701)).toEqual(nexus)
        expect(renders[0]!.versions.get(-701)).toEqual({ status: 'known', version: '2.0' })
        expect(mockListMods).not.toHaveBeenCalled()
        expect(mockNexusGetModDetail).not.toHaveBeenCalled()
    })

    it('checks a modworkshop mod and a Nexus mod through their own separate paths at once', async () => {
        const installed = [
            makeWorkshopInstall(58065, '2.11'),
            makeNexusInstall(-400, '400', '1.0.0'),
        ]
        mockListMods.mockResolvedValue({
            data: [makeWorkshopSummary(58065)],
            meta: {},
        })
        mockNexusGetModDetail.mockResolvedValue(makeNexusDetail(400, '1.1.0'))

        const { result } = renderHook(() => useModData(installed, 853, 'pd3'))

        await waitFor(() => expect(result.current.updatable).toHaveLength(2))
        expect(mockListMods).toHaveBeenCalledWith(853, { ids: [58065], limit: 1 })
        expect(mockNexusGetModDetail).toHaveBeenCalledWith('pd3', 400)
    })

    it('reports the mod as failed rather than crashing when the Nexus request rejects', async () => {
        const installed = [makeNexusInstall(-500, '500', '1.0.0')]
        mockNexusGetModDetail.mockRejectedValue(new Error('nexus API 429'))

        const { result } = renderHook(() => useModData(installed, 853, 'pd3'))

        await waitFor(() => expect(result.current.failedIds.has(-500)).toBe(true))
        expect(result.current.modData.has(-500)).toBe(false)
        expect(result.current.updatable).toEqual([])
    })

    // The reported bug: metadata that failed on an expired token stayed missing for the
    // rest of the session even after signing in again, because the installed ids had not
    // changed (so the effect never re-ran), the failure was stamped with the full
    // freshness TTL, and failedIds was never cleared.
    it('retries a mod that failed on an expired session once the user signs in again', async () => {
        const installed = [makeNexusInstall(-600, '600', '1.0.0')]
        mockNexusGetModDetail.mockRejectedValue(new Error('nexus oauth: session expired'))

        const { result } = renderHook(() => useModData(installed, 853, 'pd3'))

        await waitFor(() => expect(result.current.failedIds.has(-600)).toBe(true))
        expect(mockNexusGetModDetail).toHaveBeenCalledTimes(1)

        mockNexusGetModDetail.mockReset()
        mockNexusGetModDetail.mockResolvedValue(makeNexusDetail(600, '1.1.0'))
        // Same installed array reference, so nothing but the new session can drive this.
        emitNexusSignedIn()

        await waitFor(() => expect(result.current.updateVersions.get(-600)).toBe('1.1.0'))
        expect(mockNexusGetModDetail).toHaveBeenCalledWith('pd3', 600)
        expect(result.current.failedIds.has(-600)).toBe(false)
        expect(result.current.updatable).toHaveLength(1)
    })
})

describe('Nexus file update chains', () => {
    it('does not flag a page version bump when the installed file is still current', async () => {
        const installed = [{ ...makeNexusInstall(-810, '810', '1.0'), fileRemoteId: '81' }]
        mockNexusGetModDetail.mockResolvedValue(makeNexusDetail(810, '2.0'))
        mockFileUpdate.mockReturnValue({ status: 'current' })
        const { result } = renderHook(() => useModData(installed, 853, 'pd3'))
        await waitFor(() =>
            expect(mockFileUpdate).toHaveBeenCalledWith({ fileId: 81, version: '1.0' })
        )
        await waitFor(() => expect(result.current.modData.has(-810)).toBe(true))
        expect(result.current.updatable).toEqual([])
    })

    it('flags a file its update chain replaced, with the mod-level target version', async () => {
        const installed = [{ ...makeNexusInstall(-811, '811', '1.0'), fileRemoteId: '82' }]
        mockNexusGetModDetail.mockResolvedValue(makeNexusDetail(811, '2.0'))
        mockFileUpdate.mockReturnValue({ status: 'replaced', fileId: 83, version: '2.0' })
        const { result } = renderHook(() => useModData(installed, 853, 'pd3'))
        await waitFor(() => expect(result.current.updatable).toEqual(installed))
        expect(result.current.updateVersions.get(-811)).toBe('2.0')
    })
})
