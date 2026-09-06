import { useState } from 'react'
import type { GameId, InstalledMod, ModFolder } from '../../../shared/types'
import { GAME_STORAGE_KEY } from '../../../shared/types'
import { api } from '../api'
import { runBulkAction } from '../bulkAction'

export interface FolderActions {
    collapsedFolders: Set<string>
    renamingFolderId: string | null
    renameValue: string
    deletingFolderId: string | null
    creatingFolderParentId: string | null | undefined
    newFolderName: string
    loadingFolderId: string | null
    folderActionError: string | null
    clearFolderActionError: () => void
    startRename: (folder: ModFolder) => void
    commitRename: (folderId: string) => Promise<void>
    cancelRename: () => void
    setRenameValue: (value: string) => void
    handleDeleteFolder: (folderId: string) => void
    confirmDeleteFolder: () => Promise<void>
    cancelDelete: () => void
    startCreateFolder: (parentId: string | null) => void
    cancelCreateFolder: () => void
    setNewFolderName: (name: string) => void
    handleCreateFolder: () => Promise<void>
    toggleCollapse: (folderId: string) => void
    handleToggleFolder: (
        folderId: string,
        mods: InstalledMod[],
        anyEnabled: boolean
    ) => Promise<void>
}

export function useFolderActions(
    gamePath: string | null,
    onRefreshInstalled: () => Promise<void>,
    activeGame: GameId
): FolderActions {
    const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => {
        const saved = localStorage.getItem(`modrex:${GAME_STORAGE_KEY}:collapsed-folders`)
        return saved ? new Set(JSON.parse(saved) as string[]) : new Set()
    })
    const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)
    const [renameValue, setRenameValue] = useState('')
    const [deletingFolderId, setDeletingFolderId] = useState<string | null>(null)
    const [creatingFolderParentId, setCreatingFolderParentId] = useState<string | null | undefined>(
        undefined
    )
    const [newFolderName, setNewFolderName] = useState('')
    const [loadingFolderId, setLoadingFolderId] = useState<string | null>(null)
    const [folderActionError, setFolderActionError] = useState<string | null>(null)

    function startRename(folder: ModFolder) {
        setRenamingFolderId(folder.id)
        setRenameValue(folder.displayName)
    }

    async function commitRename(folderId: string) {
        if (!gamePath || !renameValue.trim()) {
            setRenamingFolderId(null)
            return
        }
        await api.renameFolder(folderId, renameValue.trim(), gamePath, activeGame)
        setRenamingFolderId(null)
        await onRefreshInstalled()
    }

    function cancelRename() {
        setRenamingFolderId(null)
    }

    function handleDeleteFolder(folderId: string) {
        if (!gamePath) return
        setDeletingFolderId(folderId)
    }

    async function confirmDeleteFolder() {
        if (!deletingFolderId || !gamePath) return
        const folderId = deletingFolderId
        setDeletingFolderId(null)
        await api.deleteFolder(folderId, gamePath, activeGame)
        await onRefreshInstalled()
    }

    function cancelDelete() {
        setDeletingFolderId(null)
    }

    function startCreateFolder(parentId: string | null) {
        setCreatingFolderParentId(parentId)
        setNewFolderName('')
    }

    function cancelCreateFolder() {
        setCreatingFolderParentId(undefined)
        setNewFolderName('')
    }

    async function handleCreateFolder() {
        if (creatingFolderParentId === undefined || !newFolderName.trim()) {
            cancelCreateFolder()
            return
        }
        if (!gamePath) {
            cancelCreateFolder()
            return
        }
        await api.createFolder(newFolderName.trim(), creatingFolderParentId, gamePath, activeGame)
        cancelCreateFolder()
        await onRefreshInstalled()
    }

    function toggleCollapse(folderId: string) {
        setCollapsedFolders((prev) => {
            const next = new Set(prev)
            if (next.has(folderId)) next.delete(folderId)
            else next.add(folderId)
            localStorage.setItem(
                `modrex:${GAME_STORAGE_KEY}:collapsed-folders`,
                JSON.stringify([...next])
            )
            return next
        })
    }

    // A folder toggle is a batch: one mod that will not move must not decide the rest, and the
    // refresh afterwards is what shows which ones actually changed.
    async function handleToggleFolder(folderId: string, mods: InstalledMod[], anyEnabled: boolean) {
        if (!gamePath) return
        setLoadingFolderId(folderId)
        setFolderActionError(null)
        try {
            setFolderActionError(
                await runBulkAction(
                    mods,
                    (m) => m.name,
                    (m) =>
                        anyEnabled
                            ? api.disableMod(m.uid, gamePath, activeGame)
                            : api.enableMod(m.uid, gamePath, activeGame),
                    onRefreshInstalled
                )
            )
        } finally {
            setLoadingFolderId(null)
        }
    }

    return {
        collapsedFolders,
        renamingFolderId,
        renameValue,
        deletingFolderId,
        creatingFolderParentId,
        newFolderName,
        loadingFolderId,
        folderActionError,
        clearFolderActionError: () => setFolderActionError(null),
        startRename,
        commitRename,
        cancelRename,
        setRenameValue,
        handleDeleteFolder,
        confirmDeleteFolder,
        cancelDelete,
        startCreateFolder,
        cancelCreateFolder,
        setNewFolderName,
        handleCreateFolder,
        toggleCollapse,
        handleToggleFolder,
    }
}
