import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { Dialog } from '../src/components/Dialog'
import { useDragDrop } from '../src/hooks/useDragDrop'
import { ModListRow } from '../src/components/ModListRow'
import { TooltipProvider } from '../src/components/Tooltip'
import { syntheticMod } from '../src/hooks/installedUtils'
import { api } from '../src/api'
import type { InstalledMod } from '../../shared/types'

afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
})

const installed: InstalledMod = {
    uid: 'mod',
    id: -1,
    name: 'List mod',
    version: '1',
    filename: 'mod.pak',
    enabled: true,
    installedAt: '',
    priority: 2,
}
const targetMod: InstalledMod = { ...installed, uid: 'target', id: -2, priority: 1 }
const onOpen = vi.fn()

function Draggable({ open, list = false }: { open: boolean; list?: boolean }) {
    const drag = useDragDrop({
        tabMods: [installed, targetMod],
        folders: [],
        gamePath: 'C:/game',
        modData: new Map(),
        onRefreshInstalled: async () => {},
        activeGame: 'pd3',
    })
    return (
        <div data-drop-mod="mod" onPointerDown={(event) => drag.onModPointerDown(event, 'mod')}>
            {list ? (
                <ModListRow
                    mod={{
                        ...syntheticMod(installed),
                        thumbnail: { file: 'https://example.com/mod.jpg', has_thumb: true },
                    }}
                    installed={installed}
                    gamePath="C:/game"
                    loading={false}
                    onOpen={onOpen}
                    onUninstall={onOpen}
                    onEnable={onOpen}
                    onDisable={onOpen}
                />
            ) : (
                <span data-testid="handle">Drag handle</span>
            )}
            <div data-drop-mod="target" data-testid="drop-target" />
            <output data-testid="drag-state">{drag.dragItem?.kind ?? 'idle'}</output>
            <output data-testid="drop-state">{drag.dropTarget?.kind ?? 'none'}</output>
            <Dialog open={open} onOpenChange={onOpenChange} title="Pak contents">
                <p>Popup content</p>
            </Dialog>
        </div>
    )
}

const onOpenChange = vi.fn()

async function mount(open: boolean, list = false) {
    onOpenChange.mockClear()
    onOpen.mockClear()
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(null)
    render(
        <TooltipProvider>
            <Draggable open={open} list={list} />
        </TooltipProvider>
    )
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
}

function moveFrom(target: Element) {
    fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 30, clientY: 30 })
}

test('still starts a mod drag from its handle', async () => {
    await mount(false)
    moveFrom(screen.getByTestId('handle'))
    expect(screen.getByTestId('drag-state').textContent).toBe('mod')
    expect(document.body.style.cursor).toBe('grabbing')
    fireEvent.pointerCancel(window)
    expect(screen.getByTestId('drag-state').textContent).toBe('idle')
})

test('popup interactions cannot start a mod drag or disrupt first-click dismissal', async () => {
    await mount(true)
    moveFrom(screen.getByText('Popup content'))
    expect(screen.getByTestId('drag-state').textContent).toBe('idle')
    expect(document.body.style.cursor).toBe('')
    fireEvent.pointerUp(window, { pointerId: 1 })
    const overlay = screen.getByRole('dialog').previousElementSibling!
    fireEvent.pointerDown(overlay, { button: 0, pointerId: 1 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 30, clientY: 30 })
    expect(screen.getByTestId('drag-state').textContent).toBe('idle')
    fireEvent.pointerUp(overlay, { pointerId: 1 })
    fireEvent.click(overlay)
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false)
})

test.each(['name', 'thumbnail'])(
    'reorders a list row from its %s without opening details',
    async (part) => {
        await mount(false, true)
        const source =
            part === 'name' ? screen.getByText('List mod') : document.querySelector('img')!
        const target = screen.getByTestId('drop-target')
        vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 40))
        vi.mocked(document.elementFromPoint).mockReturnValue(target)
        const reorder = vi.spyOn(api, 'reorderModsInFolder').mockResolvedValue(undefined)
        fireEvent.pointerDown(source, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
        expect(fireEvent.dragStart(source)).toBe(false)
        fireEvent.pointerMove(window, { pointerId: 1, clientX: 30, clientY: 30 })
        expect(screen.getByTestId('drag-state').textContent).toBe('mod')
        expect(screen.getByTestId('drop-state').textContent).toBe('after-mod')
        fireEvent.pointerUp(source, { pointerId: 1 })
        fireEvent.click(source)
        expect(onOpen).not.toHaveBeenCalled()
        expect(reorder).toHaveBeenCalledExactlyOnceWith(null, ['target', 'mod'], 'C:/game', 'pd3')
        await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
        fireEvent.click(source)
        expect(onOpen).toHaveBeenCalledOnce()
    }
)

test('list details retain keyboard activation and action buttons cannot start a drag', async () => {
    await mount(false, true)
    const details = screen.getByRole('button', { name: /List mod/ })
    fireEvent.keyDown(details, { key: 'Enter' })
    fireEvent.keyDown(details, { key: ' ' })
    expect(onOpen).toHaveBeenCalledTimes(2)
    moveFrom(screen.getByRole('switch'))
    expect(screen.getByTestId('drag-state').textContent).toBe('idle')
})
