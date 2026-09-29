// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { LeftoverFiles } from '../api'

const { deleteLeftoverFiles } = vi.hoisted(() => ({ deleteLeftoverFiles: vi.fn() }))
vi.mock('../api', () => ({ api: { deleteLeftoverFiles } }))
vi.mock('../hooks/useThumbnail', () => ({ useThumbnail: () => null }))
import { HealthCheckModal } from './HealthCheckModal'

function renderModal(props: Partial<ComponentProps<typeof HealthCheckModal>>) {
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
            onReinstall={vi.fn()}
            onDepInstalled={vi.fn()}
            onReviewUpdates={vi.fn()}
            onClose={vi.fn()}
            {...props}
        />
    )
}

describe('HealthCheckModal leftover files', () => {
    it('shows the tab even when there is nothing in it', async () => {
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
