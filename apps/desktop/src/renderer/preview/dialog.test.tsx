import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { Dialog } from '../src/components/Dialog'

afterEach(cleanup)

async function mount() {
    const onOpenChange = vi.fn()
    render(
        <>
            <div data-tauri-drag-region className="pointer-events-auto">
                <button>Maximize</button>
            </div>
            <div data-window-resize="East" className="pointer-events-auto" />
            <div data-testid="elsewhere" className="pointer-events-auto" />
            <Dialog open onOpenChange={onOpenChange} title="Health Check">
                <p>body</p>
            </Dialog>
        </>
    )
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    return onOpenChange
}

function press(target: Element) {
    fireEvent(target, new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    fireEvent.click(target)
}

test('keeps any dialog open when pressing window controls or resize handles', async () => {
    const onOpenChange = await mount()
    press(screen.getByRole('button', { name: 'Maximize', hidden: true }))
    press(document.querySelector('[data-window-resize]')!)
    expect(onOpenChange).not.toHaveBeenCalled()
})

test('still dismisses a dialog on a press elsewhere outside it', async () => {
    const onOpenChange = await mount()
    press(screen.getByTestId('elsewhere'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
})
