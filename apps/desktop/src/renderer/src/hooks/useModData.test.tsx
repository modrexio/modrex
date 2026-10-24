// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, configure, cleanup, act } from '@testing-library/react'
import type { InstalledMod, Mod, ModSummary } from '../../../shared/types'

configure({ asyncUtilTimeout: 10_000 })
vi.setConfig({ testTimeout: 15_000 })
afterEach(cleanup)

const mockNexusCheckFileUpdate = vi.fn()
const mockNexusGetModDetail = vi.fn()
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
        nexusCheckFileUpdate: (...args: unknown[]) => mockNexusCheckFileUpdate(...args),
        nexusGetModDetail: (...args: unknown[]) => mockNexusGetModDetail(...args),
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
        fileRemoteId: '42',
        fileId: 42,
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
    mockNexusCheckFileUpdate
        .mockReset()
        .mockResolvedValue({ status: 'replaced', fileId: 43, version: 'file-2' })
    mockNexusGetModDetail.mockReset()
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
        expect(mockNexusCheckFileUpdate).toHaveBeenCalledWith('pd3', 216, 42)
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
        expect(mockNexusCheckFileUpdate).not.toHaveBeenCalled()
    })

    it('uses a fresh cached Nexus detail as update authority', async () => {
        const first = [makeNexusInstall(-700, '700', '1.0.0')]
        mockNexusGetModDetail.mockResolvedValue(makeNexusDetail(700, '1.1.0'))
        const initial = renderHook(() => useModData(first, 853, 'pd3'))
        await waitFor(() => expect(initial.result.current.updatable).toHaveLength(1))
        initial.unmount()

        mockNexusGetModDetail.mockClear()
        mockNexusCheckFileUpdate.mockClear()
        const cached = renderHook(() => useModData(first, 853, 'pd3'))
        await waitFor(() => expect(cached.result.current.updatable).toHaveLength(1))
        expect(mockNexusGetModDetail).not.toHaveBeenCalled()
        expect(mockNexusCheckFileUpdate).not.toHaveBeenCalled()
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

it('waits for the file check and suppresses a page bump for a current file', async () => {
    const installed = [makeNexusInstall(-801, '801', '1.0')]
    mockNexusGetModDetail.mockResolvedValue(makeNexusDetail(801, '2.0'))
    let resolve!: (value: { status: 'current' }) => void
    mockNexusCheckFileUpdate.mockImplementation(
        () =>
            new Promise((done) => {
                resolve = done
            })
    )
    const { result } = renderHook(() => useModData(installed, 853, 'pd3'))
    await waitFor(() => expect(mockNexusCheckFileUpdate).toHaveBeenCalled())
    expect(result.current.updatable).toEqual([])
    await act(async () => {
        resolve({ status: 'current' })
    })
    expect(result.current.updatable).toEqual([])
    expect(result.current.failedIds.size).toBe(0)
})

it('reports an unknown replacement as an update with the mod-level target version', async () => {
    const installed = [makeNexusInstall(-802, '802', '1.0')]
    mockNexusGetModDetail.mockResolvedValue(makeNexusDetail(802, '2.0'))
    mockNexusCheckFileUpdate.mockResolvedValue({ status: 'unknown' })
    const { result } = renderHook(() => useModData(installed, 853, 'pd3'))
    await waitFor(() => expect(result.current.updatable).toHaveLength(1))
    expect(result.current.updateVersions.get(-802)).toBe('2.0')
})

it('records a failed file check without claiming current or updatable', async () => {
    const installed = [makeNexusInstall(-803, '803', '1.0')]
    mockNexusGetModDetail.mockResolvedValue(makeNexusDetail(803, '2.0'))
    mockNexusCheckFileUpdate.mockRejectedValue(new Error('nexus API 429'))
    const { result } = renderHook(() => useModData(installed, 853, 'pd3'))
    await waitFor(() => expect(mockNexusCheckFileUpdate).toHaveBeenCalled())
    await waitFor(() => expect(result.current.modData.has(-803)).toBe(true))
    expect(result.current.failedIds.has(-803)).toBe(false)
    expect(result.current.updatable).toEqual([])
    expect(result.current.updateVersions.size).toBe(0)
})

it('checks a changed installed file before offering an update and uses the fileId fallback', async () => {
    const original = { ...makeNexusInstall(-804, '804', '1.0'), fileId: 777 }
    mockNexusGetModDetail.mockResolvedValue(makeNexusDetail(804, '2.0'))
    const { result, rerender } = renderHook(({ installed }) => useModData(installed, 853, 'pd3'), {
        initialProps: { installed: [original] },
    })
    await waitFor(() => expect(result.current.updatable).toHaveLength(1))
    expect(mockNexusCheckFileUpdate).toHaveBeenCalledWith('pd3', 804, 42)
    let resolve!: (value: { status: 'current' }) => void
    mockNexusCheckFileUpdate.mockImplementation(
        () =>
            new Promise((done) => {
                resolve = done
            })
    )
    rerender({ installed: [{ ...original, fileRemoteId: undefined, fileId: 99 }] })
    expect(result.current.updatable).toEqual([])
    await waitFor(() => expect(mockNexusCheckFileUpdate).toHaveBeenLastCalledWith('pd3', 804, 99))
    expect(result.current.updatable).toEqual([])
    await act(async () => {
        resolve({ status: 'current' })
    })
    expect(result.current.updatable).toEqual([])
    expect(mockNexusGetModDetail).toHaveBeenCalledTimes(1)
})
