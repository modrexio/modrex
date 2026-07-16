import { FolderPlus, ChevronDown, ChevronRight, Pencil, Trash2, Check } from 'lucide-react'
import { Button } from './ui/Button'
import { InstalledModItem } from './InstalledModItem'
import { t } from '../i18n'
import { Tooltip } from './Tooltip'
import type { ModFolder } from '../../../shared/types'
import { Toggle } from './Toggle'
import { computeChildren, groupChildren, getAllModsInFolder } from '../hooks/installedUtils'
import { useInstalledContext } from './InstalledContext'

interface Props {
    folder: ModFolder
}

export function NewFolderInput() {
    const { folderActions } = useInstalledContext()
    const { newFolderName, setNewFolderName, handleCreateFolder, cancelCreateFolder } =
        folderActions
    return (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg border border-accent bg-accent/5">
            <FolderPlus className="w-3.5 h-3.5 text-accent shrink-0" />
            <input
                autoFocus
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreateFolder()
                    if (e.key === 'Escape') cancelCreateFolder()
                }}
                onBlur={handleCreateFolder}
                placeholder={t('installed.folder.renamePlaceholder')}
                className="flex-1 min-w-0 bg-transparent text-sm outline-none"
            />
            <button
                onClick={handleCreateFolder}
                className="p-1 rounded text-accent hover:text-accent-bright hover:bg-surface-hover transition-colors shrink-0"
            >
                <Check className="w-3.5 h-3.5" />
            </button>
        </div>
    )
}

export function FolderSection({ folder }: Props) {
    const {
        viewMode,
        gamePath,
        isFiltering,
        visibleFolderIds,
        renderMods,
        folders,
        dragItem,
        dropTarget,
        folderActions,
        onFolderPointerDown,
    } = useInstalledContext()

    const {
        collapsedFolders,
        renamingFolderId,
        renameValue,
        loadingFolderId,
        creatingFolderParentId,
        startRename,
        commitRename,
        cancelRename,
        setRenameValue,
        handleDeleteFolder,
        startCreateFolder,
        handleToggleFolder,
        toggleCollapse,
    } = folderActions

    const isCollapsed = !isFiltering && collapsedFolders.has(folder.id)
    const isRenaming = renamingFolderId === folder.id
    const isDraggingThisFolder = dragItem?.kind === 'folder' && dragItem.id === folder.id
    const isDropBeforeThis = dropTarget?.kind === 'before-child' && dropTarget.id === folder.id
    const isDropInto = dropTarget?.kind === 'into-folder' && dropTarget.folderId === folder.id

    const children = computeChildren(renderMods, folders, folder.id, visibleFolderIds)
    const isEmpty = children.length === 0
    const folderMods = getAllModsInFolder(renderMods, folders, folder.id)
    const normalizedCount = new Set(
        folderMods.map((m) => (m.id >= 0 ? `id:${m.id}` : `uid:${m.uid}`))
    ).size
    const anyEnabled = folderMods.some((m) => m.enabled)
    const isFolderLoading = loadingFolderId === folder.id

    return (
        <div
            className={`transition-opacity ${isDraggingThisFolder ? 'opacity-40' : 'opacity-100'}`}
        >
            {isDropBeforeThis && <div className="h-0.5 rounded-full bg-accent mx-2 mb-1" />}
            <div
                data-drop-folder-header={folder.id}
                data-parent-id={folder.parentId ?? ''}
                onPointerDown={(e) => {
                    if (!isRenaming) onFolderPointerDown(e, folder.id)
                }}
                className={`group flex items-center gap-1.5 px-2 py-2 rounded-lg border transition-colors ${
                    !isRenaming ? 'cursor-grab active:cursor-grabbing' : ''
                } ${isDropInto ? 'border-accent bg-accent/10' : 'border-border bg-surface-raised'}`}
            >
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => toggleCollapse(folder.id)}
                    onMouseDown={(e) => e.stopPropagation()}
                    className="-m-1 shrink-0"
                >
                    {isCollapsed ? (
                        <ChevronRight className="w-3.5 h-3.5" />
                    ) : (
                        <ChevronDown className="w-3.5 h-3.5" />
                    )}
                </Button>

                {isRenaming ? (
                    <>
                        <input
                            autoFocus
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') commitRename(folder.id)
                                if (e.key === 'Escape') cancelRename()
                            }}
                            onBlur={() => commitRename(folder.id)}
                            placeholder={t('installed.folder.renamePlaceholder')}
                            className="flex-1 min-w-0 bg-transparent text-sm font-medium outline-none border-b border-accent"
                        />
                        <button
                            onClick={() => commitRename(folder.id)}
                            className="p-1 rounded text-accent hover:text-accent-bright hover:bg-surface-hover transition-colors shrink-0"
                        >
                            <Check className="w-3.5 h-3.5" />
                        </button>
                    </>
                ) : (
                    <div className="flex items-center gap-1 flex-1 min-w-0">
                        <span
                            className="text-sm font-medium truncate cursor-default"
                            onDoubleClick={() => startRename(folder)}
                        >
                            {folder.displayName}
                        </span>
                        <Tooltip content={t('installed.folder.rename')}>
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={(e) => {
                                    e.stopPropagation()
                                    startRename(folder)
                                }}
                                onMouseDown={(e) => e.stopPropagation()}
                                className="p-0.5 shrink-0 opacity-0 group-hover:opacity-100"
                            >
                                <Pencil className="w-3 h-3" />
                            </Button>
                        </Tooltip>
                    </div>
                )}

                <span className="text-xs text-text-subtle leading-none shrink-0">
                    {t(
                        normalizedCount === 1
                            ? 'installed.folder.modCountSingle'
                            : 'installed.folder.modCount',
                        { count: normalizedCount }
                    )}
                </span>

                {!isRenaming && folderMods.length > 0 && (
                    <div
                        className="flex items-center shrink-0"
                        onMouseDown={(e) => e.stopPropagation()}
                    >
                        <Toggle
                            checked={anyEnabled}
                            onChange={() => handleToggleFolder(folder.id, folderMods, anyEnabled)}
                            disabled={isFolderLoading || !gamePath}
                            title={t(
                                anyEnabled ? 'installed.folder.disable' : 'installed.folder.enable'
                            )}
                        />
                    </div>
                )}

                {!isRenaming && gamePath && (
                    <Tooltip content={t('installed.folder.newSubfolder')}>
                        <button
                            onClick={(e) => {
                                e.stopPropagation()
                                startCreateFolder(folder.id)
                            }}
                            onMouseDown={(e) => e.stopPropagation()}
                            className="p-1.5 rounded text-text-subtle hover:text-text hover:bg-surface-active transition-colors shrink-0"
                        >
                            <FolderPlus className="w-3.5 h-3.5" />
                        </button>
                    </Tooltip>
                )}

                {!isRenaming && (
                    <Tooltip content={t('installed.folder.delete')}>
                        <Button
                            variant="danger"
                            size="icon-md"
                            onClick={(e) => {
                                e.stopPropagation()
                                handleDeleteFolder(folder.id)
                            }}
                            onMouseDown={(e) => e.stopPropagation()}
                            className="shrink-0"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                    </Tooltip>
                )}
            </div>

            {!isCollapsed && (
                <div
                    className={`ml-4 flex flex-col ${viewMode === 'grid' ? 'mt-3 gap-3' : 'mt-1.5 gap-1.5'}`}
                >
                    {creatingFolderParentId === folder.id && <NewFolderInput />}

                    {isEmpty && creatingFolderParentId !== folder.id ? (
                        <div
                            data-drop-empty-folder={folder.id}
                            className={`h-10 rounded-lg border border-dashed transition-colors flex items-center justify-center text-xs text-text-subtle ${
                                isDropInto ? 'border-accent bg-accent/5' : 'border-border'
                            }`}
                        >
                            {t('installed.folder.dropHere')}
                        </div>
                    ) : viewMode === 'list' ? (
                        children.map((child) => {
                            if (child.type === 'folder') {
                                return <FolderSection key={child.folder.id} folder={child.folder} />
                            }
                            const repUid = child.mods[0].uid
                            const isChildDropBefore =
                                dragItem?.kind === 'folder' &&
                                dropTarget?.kind === 'before-child' &&
                                dropTarget.id === repUid
                            const isChildDropAfter =
                                dragItem?.kind === 'folder' &&
                                dropTarget?.kind === 'after-child' &&
                                dropTarget.id === repUid
                            return (
                                <div
                                    key={repUid}
                                    data-drop-child={repUid}
                                    data-parent-id={folder.id}
                                >
                                    {isChildDropBefore && (
                                        <div className="h-0.5 rounded-full bg-accent mx-2 mb-1" />
                                    )}
                                    <InstalledModItem mods={child.mods} />
                                    {isChildDropAfter && (
                                        <div className="h-0.5 rounded-full bg-accent mx-2 mt-1" />
                                    )}
                                </div>
                            )
                        })
                    ) : (
                        groupChildren(children).map((group) => {
                            if (group.type === 'folder') {
                                return <FolderSection key={group.folder.id} folder={group.folder} />
                            }
                            return (
                                <div
                                    key={`rg-${group.groups[0][0].uid}`}
                                    className="grid grid-cols-2 gap-4 xl:grid-cols-3 2xl:grid-cols-4"
                                >
                                    {group.groups.map((mods) => (
                                        <InstalledModItem key={mods[0].uid} mods={mods} />
                                    ))}
                                </div>
                            )
                        })
                    )}
                </div>
            )}
        </div>
    )
}
