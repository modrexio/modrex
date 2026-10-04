// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ModFile, ModSummary } from '../../../../shared/types'
import { TooltipProvider } from '../Tooltip'

vi.mock('../../api', () => ({ api: { onNxmInstallFailed: () => () => {} } }))

import { DownloadsTab } from './DownloadsTab'

const mod: ModSummary = {
    id: 340,
    name: 'Enhanced Stockpile Shotgun Skill',
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
    user: { id: 1, name: 'Author', donation_url: null, avatar: null, avatar_has_thumb: null },
}

const file: ModFile = {
    id: 1,
    name: 'Main file',
    version: '1',
    size: 1,
    type: 'zip',
    download_url: '',
    url: 'https://www.nexusmods.com/payday3/mods/340?tab=files&file_id=1',
    image_id: null,
    desc: '[b]First line[/b]\n<br />Second line',
    label: 'MAIN',
    downloads: null,
    created_at: null,
}

afterEach(cleanup)

it('renders a Nexus file description as BBCode', () => {
    const { container } = render(
        <TooltipProvider>
            <DownloadsTab
                files={[file]}
                links={[]}
                loading={false}
                modVersion="1"
                mod={mod}
                images={[]}
                gamePath={null}
                installed={[]}
                installedFiles={[]}
                downloadMap={new Map()}
                activeGame="pd3"
                onRefreshInstalled={async () => {}}
                isNexus
            />
        </TooltipProvider>
    )
    expect(screen.getByText('First line').tagName).toBe('STRONG')
    expect(container.querySelector('.nexus-description')?.querySelectorAll('br')).toHaveLength(1)
})
