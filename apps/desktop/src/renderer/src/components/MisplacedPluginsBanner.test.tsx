// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('../api')
vi.mock('../installChoices', () => ({ requestInstallChoice: vi.fn() }))
vi.mock('../loaders', () => ({
    loaderForModId: (_game: string, modId: number) =>
        modId === 59255 ? { id: 'pdml' } : undefined,
}))

import { api } from '../api'
import { t } from '../i18n'
import { requestInstallChoice } from '../installChoices'
import { beginInstall, finishInstall, updateInstall } from '../installState'
import { MisplacedPluginsBanner } from './MisplacedPluginsBanner'

const customPing = {
    modId: 59527,
    fileId: 104639,
    name: 'Custom Ping',
    uids: ['104639_CustomPing_P'],
}
const loader = {
    modId: 59255,
    fileId: 104861,
    name: 'PAYDAY 3 MOD LOADER',
    uids: ['104449_PDML_P'],
}

function report(misplaced: (typeof loader)[], rootDescriptor: string | null = null) {
    return { target: 'plugins', misplaced, rootDescriptor }
}

function renderBanner(onRefreshInstalled = vi.fn().mockResolvedValue(undefined)) {
    render(
        <MisplacedPluginsBanner
            activeGame="pd3"
            gamePath="C:/Games/PAYDAY 3"
            installed={[]}
            onRefreshInstalled={onRefreshInstalled}
        />
    )
    return onRefreshInstalled
}

describe('MisplacedPluginsBanner', () => {
    beforeEach(() => {
        vi.mocked(api.installMod).mockResolvedValue('installed')
        vi.mocked(api.cancelDownload).mockResolvedValue(undefined)
        vi.mocked(requestInstallChoice).mockResolvedValue(undefined)
    })
    afterEach(() => {
        cleanup()
        vi.clearAllMocks()
    })

    it('shows nothing when nothing is misplaced', async () => {
        vi.mocked(api.checkPluginInstalls).mockResolvedValue(report([]))
        renderBanner()
        await waitFor(() => expect(api.checkPluginInstalls).toHaveBeenCalledWith('pd3'))
        expect(screen.queryByRole('button', { name: t('common.fix') })).toBeNull()
    })

    it('reinstalls the loader first, each from its plugin release', async () => {
        vi.mocked(api.checkPluginInstalls).mockResolvedValue(report([customPing, loader]))
        const refresh = renderBanner()
        await screen.findByText(t('installed.misplacedPlugins.message', { count: 2 }))
        fireEvent.click(screen.getByRole('button', { name: t('common.fix') }))
        await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
        expect(vi.mocked(api.installMod).mock.calls).toEqual([
            [59255, 'C:/Games/PAYDAY 3', 'pd3', 104861],
            [59527, 'C:/Games/PAYDAY 3', 'pd3', 104639],
        ])
        expect(requestInstallChoice).toHaveBeenCalledTimes(2)
    })

    it('points at a descriptor that hides every plugin in the folder', async () => {
        vi.mocked(api.checkPluginInstalls).mockResolvedValue(report([], 'PDML.uplugin'))
        renderBanner()
        await screen.findByText(
            t('installed.misplacedPlugins.rootDescriptor', { file: 'PDML.uplugin' })
        )
        fireEvent.click(screen.getByRole('button', { name: t('installed.openFolder') }))
        expect(api.openModFolder).toHaveBeenCalledWith('pd3', 'plugins')
        expect(screen.queryByRole('button', { name: t('common.fix') })).toBeNull()
    })

    it('reports a mod that could not be repaired and carries on with the rest', async () => {
        vi.mocked(api.checkPluginInstalls).mockResolvedValue(report([loader, customPing]))
        vi.mocked(api.installMod).mockRejectedValueOnce('download failed')
        renderBanner()
        await screen.findByText(t('installed.misplacedPlugins.message', { count: 2 }))
        fireEvent.click(screen.getByRole('button', { name: t('common.fix') }))
        await screen.findByText(
            t('installed.misplacedPlugins.failed', {
                name: 'PAYDAY 3 MOD LOADER',
                error: 'download failed',
            })
        )
        expect(api.installMod).toHaveBeenCalledTimes(2)
    })

    it('counts the finished repairs and shows the download progress of the current one', async () => {
        vi.mocked(api.checkPluginInstalls).mockResolvedValue(report([customPing, loader]))
        const finish: (() => void)[] = []
        vi.mocked(api.installMod).mockImplementation(
            () => new Promise((resolve) => finish.push(() => resolve('installed')))
        )
        const refresh = renderBanner()
        await screen.findByText(t('installed.misplacedPlugins.message', { count: 2 }))
        fireEvent.click(screen.getByRole('button', { name: t('common.fix') }))
        await screen.findByText('0/2')
        const operation = beginInstall({
            gameId: 'pd3',
            source: 'modworkshop',
            modId: loader.modId,
            fileId: loader.fileId,
        })
        act(() => updateInstall(operation.id, { phase: 'downloading', downloaded: 25, total: 100 }))
        expect(await screen.findByText('25%')).toBeDefined()
        expect(document.querySelector<HTMLElement>('.bg-accent')?.style.width).toBe('25%')
        act(() => finishInstall(operation.id))
        act(() => finish[0]?.())
        await screen.findByText('1/2')
        act(() => finish[1]?.())
        await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
        expect(document.querySelector('.bg-accent')).toBeNull()
    })

    it('stops the queue and cancels the download in progress', async () => {
        vi.mocked(api.checkPluginInstalls).mockResolvedValue(report([customPing, loader]))
        const finish: (() => void)[] = []
        vi.mocked(api.installMod).mockImplementation(
            () => new Promise((resolve) => finish.push(() => resolve('installed')))
        )
        const refresh = renderBanner()
        await screen.findByText(t('installed.misplacedPlugins.message', { count: 2 }))
        fireEvent.click(screen.getByRole('button', { name: t('common.fix') }))
        fireEvent.click(
            await screen.findByRole('button', { name: t('installed.misplacedPlugins.stop') })
        )
        expect(api.cancelDownload).toHaveBeenCalledWith('file:59255:104861')
        act(() => finish[0]?.())
        await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
        expect(api.installMod).toHaveBeenCalledOnce()
    })
})
