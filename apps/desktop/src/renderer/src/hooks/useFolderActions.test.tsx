// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { ModFolder } from '../../../shared/types'

const deleteFolder = vi.fn<(folderId: string, gamePath: string, gameId: string) => Promise<void>>()

async function loadHook() {
    vi.resetModules()
    vi.doMock('../api', () => ({ api: { deleteFolder } }))
    return (await import('./useFolderActions')).useFolderActions
}

const skins: ModFolder = {
    id: 'f',
    diskName: '001_Skins',
    displayName: 'Skins',
    priority: 1,
    parentId: null,
}

describe('useFolderActions delete', () => {
    it('reports a folder that could not be deleted and still refreshes', async () => {
        deleteFolder.mockRejectedValue('001_A_P.utoc is in the way')
        const onRefresh = vi.fn().mockResolvedValue(undefined)
        const useFolderActions = await loadHook()
        const { result } = renderHook(() => useFolderActions('C:/game', [skins], onRefresh, 'pd3'))

        act(() => result.current.handleDeleteFolder('f'))
        await act(() => result.current.confirmDeleteFolder())

        expect(deleteFolder).toHaveBeenCalledWith('f', 'C:/game', 'pd3')
        expect(onRefresh).toHaveBeenCalledTimes(1)
        expect(result.current.folderActionError).toContain('Skins')
        expect(result.current.folderActionError).toContain('is in the way')
    })
})
