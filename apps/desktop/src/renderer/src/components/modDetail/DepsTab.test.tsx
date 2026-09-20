// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ModDependency, ModSummary } from '../../../../shared/types'
import { TooltipProvider } from '../Tooltip'

const { states } = vi.hoisted(() => ({
    states: {
        current: new Map<
            number,
            { status: 'known'; version: string } | { status: 'unversioned' }
        >(),
    },
}))

vi.mock('../../hooks/useModVersions', () => ({ useModVersions: () => states.current }))
vi.mock('../../hooks/useThumbnail', () => ({ useThumbnail: () => null }))
vi.mock('../../api', () => ({ api: { isPd2Diesel3: vi.fn() } }))

import { DepsTab } from './DepsTab'

const summary: ModSummary = {
    id: 14924,
    name: 'BeardLib',
    desc: '',
    short_desc: '',
    downloads: 0,
    likes: 0,
    views: 0,
    published_at: '',
    bumped_at: '',
    category_id: 0,
    has_download: true,
    disable_mod_managers: null,
    thumbnail: null,
    user: { id: 1, name: 'Author', donation_url: null, avatar: null, avatar_has_thumb: null },
}
const dependency: ModDependency = {
    id: 1,
    mod_id: summary.id,
    name: null,
    url: null,
    optional: false,
    order: 1,
    mod: summary,
}

afterEach(cleanup)

it('shows only a known authoritative dependency version', () => {
    states.current = new Map([[summary.id, { status: 'known', version: 'opaque release' }]])
    const view = render(
        <TooltipProvider>
            <DepsTab
                instructions={null}
                instructsTemplate={null}
                deps={[dependency]}
                installed={[]}
                gamePath={null}
                activeGame="pd3"
                loaderInstalled={null}
                loaderModIds={{}}
                onRefreshInstalled={vi.fn().mockResolvedValue(undefined)}
            />
        </TooltipProvider>
    )
    expect(screen.getByText(/opaque release/)).toBeTruthy()

    states.current = new Map([[summary.id, { status: 'unversioned' }]])
    view.rerender(
        <TooltipProvider>
            <DepsTab
                instructions={null}
                instructsTemplate={null}
                deps={[dependency]}
                installed={[]}
                gamePath={null}
                activeGame="pd3"
                loaderInstalled={null}
                loaderModIds={{}}
                onRefreshInstalled={vi.fn().mockResolvedValue(undefined)}
            />
        </TooltipProvider>
    )
    expect(screen.queryByText(/opaque release/)).toBeNull()
})
