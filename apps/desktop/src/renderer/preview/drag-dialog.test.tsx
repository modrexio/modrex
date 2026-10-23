import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { Dialog } from '../src/components/Dialog'
import { useDragDrop } from '../src/hooks/useDragDrop'

afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
})

function Draggable({ open }: { open: boolean }) {
    const drag = useDragDrop({
        tabMods: [],
        folders: [],
        gamePath: 'C:/game',
        modData: new Map(),
        onRefreshInstalled: async () => {},
        activeGame: 'pd3',
    })
    return (
        <div onPointerDown={(event) => drag.onModPointerDown(event, 'mod')}>
            <span data-testid="handle">Drag handle</span>
            <output data-testid="drag-state">{drag.dragItem?.kind ?? 'idle'}</output>
            <Dialog open={open} onOpenChange={onOpenChange} title="Pak contents">
                <p>Popup content</p>
            </Dialog>
        </div>
    )
}

const onOpenChange = vi.fn()

async function mount(open: boolean) {
    onOpenChange.mockClear()
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(null)
    render(<Draggable open={open} />)
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
