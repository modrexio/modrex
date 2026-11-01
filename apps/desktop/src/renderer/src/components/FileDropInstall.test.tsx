// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { FileDropInstall } from './FileDropInstall'
import {
    finishResourceReview,
    getPendingResourceReview,
    requestResourceReview,
} from '../resourceInstall'

vi.mock('../hooks/useFileDropInstall', () => ({
    useFileDropInstall: () => ({
        dragging: false,
        installing: true,
        progress: null,
        result: null,
        dismissResult: vi.fn(),
        prompt: null,
        resolvePrompt: vi.fn(),
        operationTarget: { activeGame: 'pd3', gamePath: 'G:/PAYDAY3', installed: [] },
    }),
}))

afterEach(() => {
    cleanup()
    const handle = getPendingResourceReview()
    if (handle) finishResourceReview(handle, false)
})

it('steps aside while a dropped movie waits on its review', async () => {
    render(
        <FileDropInstall>
            <div />
        </FileDropInstall>
    )
    expect(await screen.findByText('Installing...')).toBeTruthy()
    act(() => {
        void requestResourceReview('dropped-movie')
    })
    await waitFor(() => expect(screen.queryByText('Installing...')).toBeNull())
    act(() => finishResourceReview('dropped-movie', true))
    expect(await screen.findByText('Installing...')).toBeTruthy()
})
