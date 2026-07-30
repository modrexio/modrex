import { createContext, useContext } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { GameId, InstalledMod, ModFolder, ModSummary } from '../../../shared/types'
import type { FolderActions } from '../hooks/useFolderActions'
import type { DragItem, DropTarget } from '../hooks/useDragDrop'

export interface InstalledContextValue {
    modData: Map<number, ModSummary>
    failedIds: Set<number>
    viewMode: 'grid' | 'list'
    activeGame: GameId
    gamePath: string | null
    isFiltering: boolean
    visibleFolderIds: Set<string> | undefined
    hiddenFolderIds: Set<string>
    renderMods: InstalledMod[]
    folders: ModFolder[]
    installed: InstalledMod[]
    onRefreshInstalled: () => Promise<void>
    onOpenDetail: (modId: number, source?: 'nexus') => void
    manageFilesKey: string | null
    setManageFilesKey: (key: string | null) => void
    loadingMod: string | null
    reinstallProgress: { downloaded: number; total: number } | null
    reinstallError: string | null
    clearReinstallError: () => void
    handleUninstall: (mods: InstalledMod[]) => Promise<void>
    handleEnable: (mods: InstalledMod[]) => Promise<void>
    handleDisable: (mods: InstalledMod[]) => Promise<void>
    handleReinstall: (mods: InstalledMod[]) => Promise<void>
    handleIdentifyViaNexus: (mod: InstalledMod) => Promise<void>
    requestMoveCrimeBossTarget: (mod: InstalledMod) => void
    folderActions: FolderActions
    dragItem: DragItem | null
    dropTarget: DropTarget
    onModPointerDown: (e: ReactPointerEvent, uid: string) => void
    onFolderPointerDown: (e: ReactPointerEvent, folderId: string) => void
}

const InstalledContext = createContext<InstalledContextValue | null>(null)

export function useInstalledContext(): InstalledContextValue {
    const ctx = useContext(InstalledContext)
    if (!ctx) throw new Error('useInstalledContext used outside InstalledContext.Provider')
    return ctx
}

export { InstalledContext }
