// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { LeftoverFiles } from '../api'

const { deleteLeftoverFiles } = vi.hoisted(() => ({ deleteLeftoverFiles: vi.fn() }))
vi.mock('../api', () => ({ api: { deleteLeftoverFiles } }))
vi.mock('../hooks/useThumbnail', () => ({ useThumbnail: () => null }))
import { HealthCheckModal } from './HealthCheckModal'

const bagTracker: LeftoverFiles = {
    target: 'paks',
    disabled: false,
    folder: '',
    stem: '018_BagTracker_P',
    files: ['018_BagTracker_P.ucas', '018_BagTracker_P.utoc'],
    bytes: 24509,
}

describe('HealthCheckModal leftover files', () => {
    it('deletes a leftover only on the second click, then refreshes the list', async () => {
        deleteLeftoverFiles.mockResolvedValue(undefined)
        const onLeftoversChanged = vi.fn().mockResolvedValue(undefined)
        render(
            <HealthCheckModal
                updateVersions={new Map()}
                installed={[]}
                updatable={[]}
                modData={new Map()}
                missingDeps={[]}
                showDepsTab={false}
                leftovers={{ sets: [bagTracker], error: null }}
                showLeftoversTab
                onLeftoversChanged={onLeftoversChanged}
                gamePath="C:/game"
                gameId="pd3"
                loadingMod={null}
                visible
                onOpenDetail={vi.fn()}
                onReinstall={vi.fn()}
                onDepInstalled={vi.fn()}
                onReviewUpdates={vi.fn()}
                onClose={vi.fn()}
            />
        )

        fireEvent.mouseDown(screen.getByRole('tab', { name: 'Leftover files (1)' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
        expect(deleteLeftoverFiles).not.toHaveBeenCalled()

        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

        await waitFor(() => expect(onLeftoversChanged).toHaveBeenCalledTimes(1))
        expect(deleteLeftoverFiles).toHaveBeenCalledWith([bagTracker], 'pd3')
    })
})
