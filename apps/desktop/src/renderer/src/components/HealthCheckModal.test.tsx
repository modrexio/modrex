// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { InstalledMod } from '../../../shared/types'
import type { LeftoverFiles } from '../api'

const { installMod, deleteLeftoverFiles } = vi.hoisted(() => ({
    installMod: vi.fn(),
    deleteLeftoverFiles: vi.fn(),
}))
vi.mock('../api', () => ({ api: { installMod, deleteLeftoverFiles } }))
vi.mock('../hooks/useThumbnail', () => ({ useThumbnail: () => null }))
import { HealthCheckModal } from './HealthCheckModal'

function missing(name: string, remoteId: string): InstalledMod {
    return {
        uid: remoteId,
        id: Number(remoteId),
        name,
        version: '1',
        filename: `${name}.pak`,
        enabled: true,
        installedAt: '',
        remoteId,
        missing: true,
    }
}

function renderModal(props: Partial<ComponentProps<typeof HealthCheckModal>>) {
    const onClose = vi.fn()
    render(
        <HealthCheckModal
            updateVersions={new Map()}
            installed={[]}
            updatable={[]}
            modData={new Map()}
            missingDeps={[]}
            showDepsTab={false}
            leftovers={{ sets: [], error: null }}
            onLeftoversChanged={vi.fn().mockResolvedValue(undefined)}
            gamePath="C:/game"
            gameId="pd3"
            loadingMod={null}
            visible
            onOpenDetail={vi.fn()}
            onReinstall={vi.fn().mockResolvedValue(null)}
            onDepInstalled={vi.fn().mockResolvedValue(undefined)}
            onReviewUpdates={vi.fn()}
            onClose={onClose}
            {...props}
        />
    )
    return onClose
}

describe('HealthCheckModal', () => {
    it('reinstalls one mod at a time, stays open and says which failed', async () => {
        const order: string[] = []
        const onReinstall = vi.fn(async (mods: InstalledMod[]) => {
            order.push(`start ${mods[0].name}`)
            await Promise.resolve()
            order.push(`end ${mods[0].name}`)
            return mods[0].name === 'Beta' ? 'the download failed' : null
        })
        const onClose = renderModal({
            installed: [missing('Alpha', '1'), missing('Beta', '2')],
            onReinstall,
        })

        fireEvent.click(screen.getByRole('button', { name: 'Reinstall All' }))

        await waitFor(() => expect(screen.getByText(/the download failed/)).toBeTruthy())
        expect(order).toEqual(['start Alpha', 'end Alpha', 'start Beta', 'end Beta'])
        expect(screen.getByText(/Beta/, { selector: 'span' })).toBeTruthy()
        expect(onClose).not.toHaveBeenCalled()
    })

    it('stays open after installing every missing dependency', async () => {
        installMod.mockResolvedValue('installed')
        const onDepInstalled = vi.fn().mockResolvedValue(undefined)
        const onClose = renderModal({
            showDepsTab: true,
            missingDeps: [
                {
                    id: 5,
                    uid: 'dep:5',
                    name: 'Needs a loader',
                    missingDeps: [{ id: 9, name: 'Loader' }],
                },
            ],
            onDepInstalled,
        })

        fireEvent.click(screen.getByRole('button', { name: 'Install All Dependencies' }))

        await waitFor(() => expect(onDepInstalled).toHaveBeenCalledTimes(1))
        expect(installMod).toHaveBeenCalledWith(9, 'C:/game', 'pd3')
        expect(onClose).not.toHaveBeenCalled()
    })

    it('shows the leftover files tab even when there is nothing in it', async () => {
        renderModal({})

        fireEvent.mouseDown(screen.getByRole('tab', { name: 'Leftover files (0)' }))

        expect(await screen.findByText('No leftover files.')).toBeTruthy()
    })

    it('deletes a leftover only on the second click, then refreshes the list', async () => {
        const bagTracker: LeftoverFiles = {
            target: 'paks',
            disabled: false,
            folder: '',
            stem: '018_BagTracker_P',
            files: ['018_BagTracker_P.ucas', '018_BagTracker_P.utoc'],
            bytes: 24509,
        }
        deleteLeftoverFiles.mockResolvedValue(undefined)
        const onLeftoversChanged = vi.fn().mockResolvedValue(undefined)
        renderModal({ leftovers: { sets: [bagTracker], error: null }, onLeftoversChanged })

        fireEvent.mouseDown(screen.getByRole('tab', { name: 'Leftover files (1)' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
        expect(deleteLeftoverFiles).not.toHaveBeenCalled()

        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

        await waitFor(() => expect(onLeftoversChanged).toHaveBeenCalledTimes(1))
        expect(deleteLeftoverFiles).toHaveBeenCalledWith([bagTracker], 'pd3')
    })
})
