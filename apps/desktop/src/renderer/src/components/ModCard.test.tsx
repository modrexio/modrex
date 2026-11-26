// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { InstalledMod, ModSummary } from '../../../shared/types'

vi.mock('./Tooltip', () => ({
    Tooltip: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('../hooks/useThumbnail', () => ({ useThumbnail: () => null }))
vi.mock('../../../../assets/icons/nexusmods.svg?react', () => ({ default: () => null }))

import { ModCard } from './ModCard'
import { t } from '../i18n'

afterEach(cleanup)

const mod: ModSummary = {
    id: 59255,
    name: 'PAYDAY 3 MOD LOADER',
    desc: '',
    short_desc: '',
    legacy_markup: false,
    downloads: 6000,
    likes: 103,
    views: 8300,
    published_at: '',
    bumped_at: '',
    category_id: 0,
    has_download: true,
    disable_mod_managers: null,
    download_type: null,
    thumbnail: null,
    user: { id: 1, name: 'Nadz', donation_url: null, avatar: null, avatar_has_thumb: null },
}

function record(overrides: Partial<InstalledMod>): InstalledMod {
    return {
        uid: 'pdml',
        installId: 'pdml',
        id: -7,
        name: 'PDML',
        version: '1',
        filename: 'PDML',
        enabled: true,
        installedAt: '',
        source: 'modworkshop',
        remoteId: String(mod.id),
        ...overrides,
    }
}

function renderCard(installed: InstalledMod | undefined) {
    render(
        <ModCard
            mod={mod}
            installed={installed}
            loaderInstalled
            onOpen={() => {}}
            onInstall={() => {}}
            onUninstall={() => {}}
            onEnable={() => {}}
            onDisable={() => {}}
            loading={false}
            gamePath="C:/game"
            showMeta
        />
    )
}

it('shows a loader tracked as a mod with the controls of a mod, not a presence label', () => {
    renderCard(record({ location: 'plugins' }))
    expect(screen.getByRole('switch')).toBeTruthy()
    expect(screen.queryByText(t('detail.deps.statusInstalled'))).toBeNull()
})

it('keeps the presence label for a detected loader, which cannot be toggled', () => {
    renderCard(record({ uid: 'loader:ue4ss', location: 'loader:ue4ss' }))
    expect(screen.getByText(t('detail.deps.statusInstalled'))).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
})

it('keeps the presence label for a loader with no record', () => {
    renderCard(undefined)
    expect(screen.getByText(t('detail.deps.statusInstalled'))).toBeTruthy()
    expect(screen.queryByRole('button', { name: t('common.install') })).toBeNull()
})
