import { useRef, useState, useEffect } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { GameId, Mod, InstalledMod, ModFolder, TopLevelItem } from '../../../shared/types'
import { THUMBNAIL_BASE_URL } from '../../../shared/types'
import { computeChildren, syntheticMod } from './installedUtils'
import { api } from '../api'

export type DragItem = { kind: 'mod'; uid: string } | { kind: 'folder'; id: string }

export type DropTarget =
    | { kind: 'before-mod'; uid: string }
    | { kind: 'after-mod'; uid: string }
    | { kind: 'into-folder'; folderId: string }
    | { kind: 'before-child'; id: string; itemType: 'folder' | 'mod'; parentId: string | null }
    | { kind: 'after-child'; id: string; itemType: 'folder' | 'mod'; parentId: string | null }
    | null

interface Options {
    installed: InstalledMod[]
    folders: ModFolder[]
    gamePath: string | null
    modData: Map<number, Mod>
    onRefreshInstalled: () => Promise<void>
    activeGame?: GameId
}

// Native OS file-drop (dragDropEnabled: true) disables HTML5 DnD in the webview, so
// reordering runs on pointer events instead. Once a drag starts the pointer is not
// captured; the moving element is hit-tested via document.elementFromPoint against the
// data-drop-* attributes below. Drop targets carry:
//   data-drop-mod=<uid>                         a mod (reorder / before-after)
//   data-drop-folder-header=<id> data-parent-id folder header (into / reorder)
//   data-drop-empty-folder=<id>                 an empty folder's drop zone
//   data-drop-child=<uid|id> data-parent-id     a slot a dragged folder can sit among
const DRAG_THRESHOLD = 5
const SCROLL_ZONE = 80

export function useDragDrop({
    installed,
    folders,
    gamePath,
    modData,
    onRefreshInstalled,
    activeGame,
}: Options) {
    const [dragItem, setDragItemState] = useState<DragItem | null>(null)
    const [dropTarget, setDropTargetState] = useState<DropTarget>(null)
    const dragItemRef = useRef<DragItem | null>(null)
    const dropTargetRef = useRef<DropTarget>(null)
    const scrollContainerRef = useRef<HTMLDivElement>(null)

    // Pending = pointer down on a handle but movement hasn't crossed the threshold yet.
    const pendingRef = useRef<{
        item: DragItem
        startX: number
        startY: number
        pointerId: number
    } | null>(null)
    const startedRef = useRef(false)
    const dragImageRef = useRef<HTMLElement | null>(null)
    const imageOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
    const listenersRef = useRef<{
        move: (e: PointerEvent) => void
        up: (e: PointerEvent) => void
        cancel: () => void
        key: (e: KeyboardEvent) => void
        drag: (e: DragEvent) => void
    } | null>(null)

    // Auto-scroll while dragging near the scroll container's edges.
    const dragScrollFrame = useRef<number | null>(null)
    const dragScrollDir = useRef<'up' | 'down' | null>(null)
    const dragClientY = useRef<number>(0)

    function setDragItem(v: DragItem | null) {
        dragItemRef.current = v
        setDragItemState(v)
    }
    function setDrop(v: DropTarget) {
        dropTargetRef.current = v
        setDropTargetState(v)
    }

    // ── Drag image (follows the pointer; replaces dataTransfer.setDragImage) ─────
    function buildModDragImage(mod: Mod): HTMLElement {
        const el = document.createElement('div')
        el.style.cssText =
            'position:fixed;z-index:9999;pointer-events:none;display:flex;flex-direction:column;' +
            'background:var(--color-surface-raised);border:1px solid var(--color-border);border-radius:8px;' +
            'box-shadow:0 4px 16px rgba(0,0,0,0.6);width:160px;overflow:hidden;'
        if (mod.thumbnail) {
            const img = document.createElement('img')
            img.src = `${THUMBNAIL_BASE_URL}/${mod.thumbnail.file}`
            img.style.cssText = 'width:160px;height:90px;object-fit:cover;display:block;'
            el.appendChild(img)
        } else {
            const placeholder = document.createElement('div')
            placeholder.style.cssText =
                'width:160px;height:90px;background:var(--color-surface-hover);'
            el.appendChild(placeholder)
        }
        const name = document.createElement('span')
        name.textContent = mod.name
        name.style.cssText =
            'font-size:12px;color:var(--color-text);padding:6px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
        el.appendChild(name)
        return el
    }

    function buildFolderDragImage(name: string): HTMLElement {
        const el = document.createElement('div')
        el.textContent = name
        el.style.cssText =
            'position:fixed;z-index:9999;pointer-events:none;background:var(--color-surface-raised);' +
            'border:1px solid var(--color-border);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.6);' +
            'padding:6px 10px;font-size:12px;font-weight:500;color:var(--color-text);max-width:220px;' +
            'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
        return el
    }

    function positionDragImage(x: number, y: number) {
        const el = dragImageRef.current
        if (!el) return
        el.style.left = `${x - imageOffsetRef.current.x}px`
        el.style.top = `${y - imageOffsetRef.current.y}px`
    }

    // ── Auto-scroll ─────────────────────────────────────────────────────────────
    function stopAutoScroll() {
        if (dragScrollFrame.current !== null) {
            cancelAnimationFrame(dragScrollFrame.current)
            dragScrollFrame.current = null
        }
    }

    function updateAutoScroll(clientY: number) {
        dragClientY.current = clientY
        const container = scrollContainerRef.current
        if (!container) return
        const { top, bottom } = container.getBoundingClientRect()
        let dir: 'up' | 'down' | null = null
        if (clientY < top + SCROLL_ZONE) dir = 'up'
        else if (clientY > bottom - SCROLL_ZONE) dir = 'down'
        if (dir === dragScrollDir.current) return
        dragScrollDir.current = dir
        stopAutoScroll()
        if (!dir) return
        const loop = () => {
            if (!dragScrollDir.current) return
            const ct = scrollContainerRef.current
            if (!ct) return
            const { top: t, bottom: b } = ct.getBoundingClientRect()
            const y = dragClientY.current
            const ratio =
                dragScrollDir.current === 'up'
                    ? (t + SCROLL_ZONE - y) / SCROLL_ZONE
                    : (y - (b - SCROLL_ZONE)) / SCROLL_ZONE
            const speed = Math.round(Math.min(1, ratio) * 12)
            ct.scrollBy(0, dragScrollDir.current === 'up' ? -speed : speed)
            dragScrollFrame.current = requestAnimationFrame(loop)
        }
        dragScrollFrame.current = requestAnimationFrame(loop)
    }

    // ── Drop-target computation (pure; ported from the old dragOver handlers) ────
    function computeModDragOver(clientY: number, rect: DOMRect, uid: string): DropTarget {
        const item = dragItemRef.current
        if (!item || item.kind === 'folder') return null
        if (item.uid === uid) return null
        const srcMod = installed.find((m) => m.uid === item.uid)
        const targetMod = installed.find((m) => m.uid === uid)
        if (!srcMod || !targetMod) return null

        // Secondary-target mods (e.g. mod_overrides) can only reorder within their own scope.
        if (srcMod.location && (srcMod.folderId ?? null) !== (targetMod.folderId ?? null))
            return null

        const isTop = clientY - rect.top < rect.height / 2

        if ((srcMod.folderId ?? null) === (targetMod.folderId ?? null)) {
            const srcFolderId = srcMod.folderId ?? null
            const scopedMods = installed
                .filter((m) => (m.folderId ?? null) === srcFolderId)
                .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
            const srcGroupSize = scopedMods.filter((m) => m.id === srcMod.id).length
            const srcOrigIdx = scopedMods.findIndex((m) => m.uid === srcMod.uid)
            const noOpNeighbor = isTop
                ? scopedMods[srcOrigIdx + srcGroupSize]
                : srcOrigIdx > 0
                  ? scopedMods[srcOrigIdx - 1]
                  : undefined
            if (noOpNeighbor?.id === targetMod.id) return null
        }

        return isTop ? { kind: 'before-mod', uid } : { kind: 'after-mod', uid }
    }

    function computeFolderHeaderDragOver(
        clientY: number,
        rect: DOMRect,
        folderId: string,
        folderParentId: string | null
    ): DropTarget {
        const item = dragItemRef.current
        if (!item) return null
        if (item.kind === 'mod') {
            const srcMod = installed.find((m) => m.uid === item.uid)
            if (srcMod?.location) return null
            return { kind: 'into-folder', folderId }
        }
        // folder dragged over folder header: bottom half = nest inside, top half = reorder before
        const isBottom = clientY - rect.top > rect.height / 2
        if (isBottom && folderId !== item.id) return { kind: 'into-folder', folderId }
        return { kind: 'before-child', id: folderId, itemType: 'folder', parentId: folderParentId }
    }

    function computeChildModDragOver(
        clientY: number,
        rect: DOMRect,
        uid: string,
        parentId: string | null
    ): DropTarget {
        const item = dragItemRef.current
        if (!item || item.kind !== 'folder') return null
        const isBottom = clientY - rect.top > rect.height / 2
        return isBottom
            ? { kind: 'after-child', id: uid, itemType: 'mod', parentId }
            : { kind: 'before-child', id: uid, itemType: 'mod', parentId }
    }

    function computeEmptyFolderDragOver(folderId: string): DropTarget {
        const item = dragItemRef.current
        if (!item || item.kind !== 'mod') return null
        const srcMod = installed.find((m) => m.uid === item.uid)
        if (srcMod?.location) return null
        return { kind: 'into-folder', folderId }
    }

    function updateDropTarget(clientX: number, clientY: number) {
        const item = dragItemRef.current
        if (!item) return
        const el = document.elementFromPoint(clientX, clientY)
        if (!el) {
            setDrop(null)
            return
        }
        const header = el.closest('[data-drop-folder-header]') as HTMLElement | null
        if (header) {
            setDrop(
                computeFolderHeaderDragOver(
                    clientY,
                    header.getBoundingClientRect(),
                    header.dataset.dropFolderHeader!,
                    header.dataset.parentId || null
                )
            )
            return
        }
        if (item.kind === 'mod') {
            const empty = el.closest('[data-drop-empty-folder]') as HTMLElement | null
            if (empty) {
                setDrop(computeEmptyFolderDragOver(empty.dataset.dropEmptyFolder!))
                return
            }
            const modZone = el.closest('[data-drop-mod]') as HTMLElement | null
            if (modZone) {
                setDrop(
                    computeModDragOver(
                        clientY,
                        modZone.getBoundingClientRect(),
                        modZone.dataset.dropMod!
                    )
                )
                return
            }
            setDrop(null)
            return
        }
        const child = el.closest('[data-drop-child]') as HTMLElement | null
        if (child) {
            setDrop(
                computeChildModDragOver(
                    clientY,
                    child.getBoundingClientRect(),
                    child.dataset.dropChild!,
                    child.dataset.parentId || null
                )
            )
            return
        }
        setDrop(null)
    }

    // ── Drop application (ported from the old drop handlers) ─────────────────────
    async function applyModReorder(srcRepUid: string, targetRepUid: string, isBefore: boolean) {
        if (!gamePath || targetRepUid === srcRepUid) return
        const srcMod = installed.find((m) => m.uid === srcRepUid)
        const targetMod = installed.find((m) => m.uid === targetRepUid)
        if (!srcMod || !targetMod) return
        const srcFolderId = srcMod.folderId ?? null
        const targetFolderId = targetMod.folderId ?? null
        const srcGroupMods = installed
            .filter((m) => (m.folderId ?? null) === srcFolderId && m.id === srcMod.id)
            .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))

        if (srcFolderId === targetFolderId) {
            const scopedMods = installed
                .filter((m) => (m.folderId ?? null) === srcFolderId)
                .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
            const withoutSrc = scopedMods.filter((m) => m.id !== srcMod.id)
            const targetGroupMods = withoutSrc.filter((m) => m.id === targetMod.id)
            const pivotUid = isBefore
                ? targetGroupMods[0].uid
                : targetGroupMods[targetGroupMods.length - 1].uid
            const pivotIdx = withoutSrc.findIndex((m) => m.uid === pivotUid)
            const insertAt = isBefore ? pivotIdx : pivotIdx + 1
            const reordered = [...withoutSrc]
            reordered.splice(insertAt, 0, ...srcGroupMods)
            await api.reorderModsInFolder(
                srcFolderId,
                reordered.map((m) => m.uid),
                gamePath,
                activeGame
            )
        } else if (!srcMod.location) {
            const targetScopeMods = installed
                .filter((m) => (m.folderId ?? null) === targetFolderId && m.id !== srcMod.id)
                .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
            const toIdx = targetScopeMods.findIndex((m) => m.uid === targetRepUid)
            const targetPosition = isBefore ? toIdx : toIdx + 1
            for (const m of srcGroupMods) {
                await api.moveModToFolder(
                    m.uid,
                    targetFolderId,
                    targetPosition,
                    gamePath,
                    activeGame
                )
            }
        }
        await onRefreshInstalled()
    }

    async function applyDropIntoFolder(srcRepUid: string, folderId: string) {
        if (!gamePath) return
        const srcMod = installed.find((m) => m.uid === srcRepUid)
        if (!srcMod || (srcMod.folderId ?? null) === folderId || srcMod.location) return
        const srcGroupMods = installed.filter(
            (m) => (m.folderId ?? null) === (srcMod.folderId ?? null) && m.id === srcMod.id
        )
        const folderMods = installed.filter((m) => m.folderId === folderId)
        for (const m of srcGroupMods) {
            await api.moveModToFolder(m.uid, folderId, folderMods.length, gamePath, activeGame)
        }
        await onRefreshInstalled()
    }

    async function applyChildDrop(
        srcFolderId: string,
        targetId: string,
        targetItemType: 'folder' | 'mod',
        parentId: string | null,
        isAfter: boolean
    ) {
        if (!gamePath) return
        if (targetItemType === 'folder' && targetId === srcFolderId) return

        const contextItems = computeChildren(installed, folders, parentId)
        const items: TopLevelItem[] = contextItems
            .filter((item) => !(item.type === 'folder' && item.folder.id === srcFolderId))
            .flatMap((item): TopLevelItem[] =>
                item.type === 'folder'
                    ? [{ type: 'folder', id: item.folder.id }]
                    : item.mods.map((m) => ({ type: 'mod', id: m.uid }))
            )

        const insertIdx = items.findIndex(
            (item) => item.type === targetItemType && item.id === targetId
        )
        if (insertIdx === -1) return
        const insertPos = isAfter ? insertIdx + 1 : insertIdx
        items.splice(insertPos, 0, { type: 'folder', id: srcFolderId })

        const draggedFolder = folders.find((f) => f.id === srcFolderId)
        if (draggedFolder && draggedFolder.parentId !== parentId) {
            await api.moveFolder(srcFolderId, parentId, gamePath, activeGame)
        }
        await api.reorderChildren(parentId, items, gamePath, activeGame)
        await onRefreshInstalled()
    }

    async function applyNestFolder(srcFolderId: string, targetFolderId: string) {
        if (!gamePath || srcFolderId === targetFolderId) return
        await api.moveFolder(srcFolderId, targetFolderId, gamePath, activeGame)
        await onRefreshInstalled()
    }

    // ── Pointer lifecycle ───────────────────────────────────────────────────────
    function resetDrag() {
        startedRef.current = false
        pendingRef.current = null
        setDragItem(null)
        setDrop(null)
        if (dragImageRef.current) {
            dragImageRef.current.remove()
            dragImageRef.current = null
        }
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
        stopAutoScroll()
        dragScrollDir.current = null
    }

    function teardownListeners() {
        const l = listenersRef.current
        if (!l) return
        window.removeEventListener('pointermove', l.move)
        window.removeEventListener('pointerup', l.up)
        window.removeEventListener('pointercancel', l.cancel)
        window.removeEventListener('keydown', l.key)
        window.removeEventListener('dragstart', l.drag)
        listenersRef.current = null
    }

    function beginDrag(clientX: number, clientY: number) {
        const p = pendingRef.current
        if (!p) return
        const item = p.item
        startedRef.current = true
        setDragItem(item)
        if (item.kind === 'mod') {
            const ins = installed.find((m) => m.uid === item.uid)
            const mod = ins ? (modData.get(ins.id) ?? syntheticMod(ins)) : null
            if (mod) {
                dragImageRef.current = buildModDragImage(mod)
                imageOffsetRef.current = { x: 80, y: 45 }
                document.body.appendChild(dragImageRef.current)
            }
        } else {
            const folder = folders.find((f) => f.id === item.id)
            dragImageRef.current = buildFolderDragImage(folder?.displayName ?? '')
            imageOffsetRef.current = { x: 12, y: 12 }
            document.body.appendChild(dragImageRef.current)
        }
        document.body.style.userSelect = 'none'
        document.body.style.cursor = 'grabbing'
        positionDragImage(clientX, clientY)
    }

    function handlePointerMove(e: PointerEvent) {
        const p = pendingRef.current
        if (!p || e.pointerId !== p.pointerId) return
        if (!startedRef.current) {
            if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) < DRAG_THRESHOLD) return
            beginDrag(e.clientX, e.clientY)
        }
        positionDragImage(e.clientX, e.clientY)
        updateAutoScroll(e.clientY)
        updateDropTarget(e.clientX, e.clientY)
    }

    async function runDrop() {
        const item = dragItemRef.current
        const dt = dropTargetRef.current
        const srcUid = item?.kind === 'mod' ? item.uid : null
        const srcFolderId = item?.kind === 'folder' ? item.id : null
        resetDrag()
        if (!item || !dt || !gamePath) return
        if (item.kind === 'mod' && srcUid) {
            if (dt.kind === 'before-mod' || dt.kind === 'after-mod') {
                await applyModReorder(srcUid, dt.uid, dt.kind === 'before-mod')
            } else if (dt.kind === 'into-folder') {
                await applyDropIntoFolder(srcUid, dt.folderId)
            }
        } else if (item.kind === 'folder' && srcFolderId) {
            if (dt.kind === 'into-folder') {
                await applyNestFolder(srcFolderId, dt.folderId)
            } else if (dt.kind === 'before-child' || dt.kind === 'after-child') {
                await applyChildDrop(
                    srcFolderId,
                    dt.id,
                    dt.itemType,
                    dt.parentId,
                    dt.kind === 'after-child'
                )
            }
        }
    }

    function handlePointerUp() {
        const wasDragging = startedRef.current
        teardownListeners()
        if (!wasDragging) {
            resetDrag()
            return
        }
        // A real drag just ended — swallow the click the browser fires next (only when
        // pointer up/down share an element, e.g. a drop back onto the origin) so it
        // doesn't open the mod detail page. Remove on the next tick so that, when no
        // click fires, the guard doesn't eat the user's following real click.
        const swallowClick = (ev: MouseEvent) => {
            ev.stopPropagation()
            ev.preventDefault()
        }
        window.addEventListener('click', swallowClick, { capture: true })
        setTimeout(() => window.removeEventListener('click', swallowClick, true), 0)
        void runDrop()
    }

    function cancelDrag() {
        teardownListeners()
        resetDrag()
    }

    function startPending(e: ReactPointerEvent, item: DragItem) {
        if (e.button !== 0 || !gamePath) return
        if ((e.target as HTMLElement).closest('button, a, input, textarea, select, [data-no-drag]'))
            return
        pendingRef.current = { item, startX: e.clientX, startY: e.clientY, pointerId: e.pointerId }
        const move = handlePointerMove
        const up = handlePointerUp
        const cancel = cancelDrag
        const key = (ev: KeyboardEvent) => {
            if (ev.key === 'Escape') cancelDrag()
        }
        // Images/links are natively draggable; with dragDropEnabled: false the webview's
        // HTML5 drag would otherwise fire and preempt our pointermove. Cancel it.
        const drag = (ev: DragEvent) => ev.preventDefault()
        listenersRef.current = { move, up, cancel, key, drag }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        window.addEventListener('pointercancel', cancel)
        window.addEventListener('keydown', key)
        window.addEventListener('dragstart', drag)
    }

    function onModPointerDown(e: ReactPointerEvent, uid: string) {
        startPending(e, { kind: 'mod', uid })
    }
    function onFolderPointerDown(e: ReactPointerEvent, folderId: string) {
        startPending(e, { kind: 'folder', id: folderId })
    }

    useEffect(() => {
        return () => {
            teardownListeners()
            resetDrag()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    return {
        dragItem,
        dropTarget,
        scrollContainerRef,
        onModPointerDown,
        onFolderPointerDown,
    }
}
