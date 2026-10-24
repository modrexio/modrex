// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { ModSummary } from '../../../shared/types'
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
vi.mock('./ModCard', () => ({ ModCard: ({ mod }: { mod: ModSummary }) => <div>{mod.name}</div> }))
vi.mock('./SkeletonCard', () => ({ SkeletonCard: () => <div data-testid="skeleton" /> }))

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

function renderPage(isActive = true) {
    return render(
        <BrowsePage
            activeGame="pd3"
            workshopId={853}
            isActive={isActive}
            source="modworkshop"
            onSourceChange={vi.fn()}
            gamePath={null}
            gamePathReady
            installed={[]}
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
