// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('../api')
vi.mock('../requestPriority', () => ({ waitForForegroundClear: async () => {} }))

beforeEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
})

afterEach(cleanup)

it.each(['onNexusSignedOut', 'onNexusSessionExpired'] as const)(
    'drops shared Nexus counts without re-fetching on %s',
    async (event) => {
        const { api } = await import('../api')
        vi.mocked(api.isNexusSignedIn).mockResolvedValue(true)
        vi.mocked(api.nexusSearchMods).mockResolvedValue({
            data: [],
            meta: { total: 5151, current_page: 1, last_page: 215, per_page: 24 },
        })
        vi.mocked(api.listSources).mockResolvedValue([
            { id: 'nexus', games: [{ gameId: 'ron', nativeId: 'readyornot' }] },
        ])
        const { loadSourceRegistry } = await import('../sources')
        await loadSourceRegistry()
        const { SourceSelect } = await import('./SourceSelect')
        const { t } = await import('../i18n')
        const props = { activeGame: 'ron' as const, value: 'nexus', onChange: vi.fn() }
        render(
            <>
                <SourceSelect {...props} />
                <SourceSelect {...props} />
            </>
        )
        const count = t('browse.modCount', { total: '5.2k' })
        expect(await screen.findAllByText(count)).toHaveLength(2)
        expect(api.nexusSearchMods).toHaveBeenCalledTimes(1)
        act(() => vi.mocked(api[event]).mock.calls[0]![0]())
        expect(screen.queryAllByText(count)).toHaveLength(0)
        expect(api.nexusSearchMods).toHaveBeenCalledTimes(1)
        expect(api.isNexusSignedIn).toHaveBeenCalledTimes(1)
    }
)
