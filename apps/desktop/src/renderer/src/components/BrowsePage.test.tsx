// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { InstalledMod, ModSummary } from '../../../shared/types'
import fixture from '../../preview/fixtures/pd3/mods.json'

const mods = {
    ...fixture,
    data: fixture.data.map((mod) => ({ ...mod, legacy_markup: false, download_type: null })),
}

vi.mock('../api')
vi.mock('./SourceSelect', () => ({ SourceSelect: () => null }))
vi.mock('./ScrollArea', () => ({
    ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('./ModCard', () => ({
    ModCard: ({ mod, onUninstall }: { mod: ModSummary; onUninstall: (id: number) => void }) => (
        <>
            <div>{mod.name}</div>
            <button aria-label={`remove ${mod.id}`} onClick={() => onUninstall(mod.id)} />
        </>
    ),
}))
vi.mock('./SkeletonCard', () => ({ SkeletonCard: () => <div data-testid="skeleton" /> }))
vi.mock('./Ue4ssRemoveModal', () => ({
    Ue4ssRemoveModal: () => <div data-testid="ue4ss-remove" />,
}))

import { api } from '../api'
import { setBrowseCache, setCategoriesCache, setTagsCache } from '../browseCache'
import { BrowsePage } from './BrowsePage'

beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
    setCategoriesCache(853, [])
    setTagsCache(853, [])
})

afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.clearAllMocks()
})

function renderPage(
    isActive = true,
    gamePath: string | null = null,
    installed: InstalledMod[] = []
) {
    return render(
        <BrowsePage
            activeGame="pd3"
            workshopId={853}
            isActive={isActive}
            source="modworkshop"
            onSourceChange={vi.fn()}
            gamePath={gamePath}
            gamePathReady
            installed={installed}
            onRefreshInstalled={vi.fn(async () => {})}
            onOpenDetail={vi.fn()}
        />
    )
}

describe('Browse cached activation', () => {
    it.each([false, true])(
        'keeps cached cards on first activation with stale=%s',
        async (stale) => {
            setBrowseCache(853, 1, '', 'bumped_at', undefined, mods)
            if (stale) vi.setSystemTime(Date.now() + 5 * 60 * 1000)
            vi.mocked(api.listMods).mockReturnValue(new Promise(() => {}))
            renderPage()

            expect(screen.getByText(mods.data[0]!.name)).toBeTruthy()
            expect(screen.queryAllByTestId('skeleton')).toHaveLength(0)
            await act(() => vi.advanceTimersByTimeAsync(0))
            expect(screen.getByText(mods.data[0]!.name)).toBeTruthy()
            expect(screen.queryAllByTestId('skeleton')).toHaveLength(0)
            expect(api.listMods).toHaveBeenCalledTimes(stale ? 1 : 0)

            fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new query' } })
            expect(screen.queryAllByTestId('skeleton')).toHaveLength(24)
            await act(() => vi.advanceTimersByTimeAsync(400))
            expect(api.listMods).toHaveBeenLastCalledWith(
                853,
                expect.objectContaining({ query: 'new query' })
            )
        }
    )
})

describe('Browse remove', () => {
    const page = mods.data[0]!
    const record = (overrides: Partial<InstalledMod>): InstalledMod => ({
        uid: 'mod',
        installId: 'mod',
        id: -7,
        name: page.name,
        version: '1',
        filename: page.name,
        enabled: true,
        installedAt: '',
        source: 'modworkshop',
        remoteId: String(page.id),
        ...overrides,
    })

    beforeEach(() => {
        setBrowseCache(853, 1, '', 'bumped_at', undefined, mods)
        vi.mocked(api.ue4ssPresence).mockResolvedValue({
            installed: true,
            modworkshopId: page.id,
            version: null,
            unrecognized: [],
        })
        vi.mocked(api.uninstallMod).mockResolvedValue()
    })

    it('asks before removing a detected loader instead of uninstalling it as a mod', async () => {
        renderPage(true, 'C:/game', [record({ uid: 'loader:ue4ss', location: 'loader:ue4ss' })])
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: `remove ${page.id}` }))
        })
        expect(screen.getByTestId('ue4ss-remove')).toBeTruthy()
        expect(api.uninstallMod).not.toHaveBeenCalled()
    })

    it('uninstalls a tracked mod directly', async () => {
        renderPage(true, 'C:/game', [record({})])
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: `remove ${page.id}` }))
        })
        expect(screen.queryByTestId('ue4ss-remove')).toBeNull()
        expect(api.uninstallMod).toHaveBeenCalledWith('mod', 'C:/game', 'pd3')
    })
})
