// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FileDropOverlay, FileDropStatus } from './FileDropOverlay'
import { t } from '../i18n'

let animationStyles: HTMLStyleElement

beforeEach(() => {
    animationStyles = document.createElement('style')
    animationStyles.textContent = `
        .animate-drop-overlay-in { animation-name: fade-in; }
        .animate-drop-overlay-out { animation-name: fade-out; }
        .animate-drop-panel-out { animation-name: drop-panel-out; }
        .animate-drop-status-in { animation-name: drop-status-in; }
        .animate-drop-status-out { animation-name: drop-status-out; }
    `
    document.head.append(animationStyles)
})

afterEach(() => {
    cleanup()
    animationStyles.remove()
})

describe('file drop exit animations', () => {
    it('keeps the overlay until its own exit ends, ignoring child and enter events', () => {
        const props = { installing: false, progress: null, gameName: 'PAYDAY 3' }
        const { container, rerender } = render(<FileDropOverlay {...props} active />)
        const overlay = container.firstElementChild!
        const panel = overlay.firstElementChild!

        rerender(<FileDropOverlay {...props} active={false} />)
        expect(screen.queryByText(t('drop.overlayTitle'))).not.toBeNull()
        fireEvent.animationEnd(panel, { animationName: 'drop-panel-out' })
        fireEvent.animationEnd(overlay, { animationName: 'fade-in' })
        expect(container.firstElementChild).toBe(overlay)

        fireEvent.animationEnd(overlay, { animationName: 'fade-out' })
        expect(container.firstElementChild).toBeNull()
    })

    it('retains the last toast message during dismissal and removes it on exit', () => {
        const result = { kind: 'done', message: 'Installed test mod' } as const
        const onDismiss = vi.fn()
        const { rerender } = render(<FileDropStatus result={result} onDismiss={onDismiss} />)
        const toast = screen.getByText(result.message).parentElement!

        fireEvent.click(screen.getByRole('button'))
        expect(onDismiss).toHaveBeenCalledOnce()
        rerender(<FileDropStatus result={null} onDismiss={onDismiss} />)
        expect(screen.queryByText(result.message)).not.toBeNull()

        fireEvent.animationEnd(toast, { animationName: 'drop-status-out' })
        expect(screen.queryByText(result.message)).toBeNull()
    })

    it('keeps a new result when an interrupted exit ends', () => {
        const onDismiss = vi.fn()
        const first = { kind: 'done', message: 'First mod installed' } as const
        const second = { kind: 'error', message: 'Second mod failed' } as const
        const { rerender } = render(<FileDropStatus result={null} onDismiss={onDismiss} />)
        rerender(<FileDropStatus result={first} onDismiss={onDismiss} />)
        const toast = screen.getByText(first.message).parentElement!
        rerender(<FileDropStatus result={null} onDismiss={onDismiss} />)
        rerender(<FileDropStatus result={second} onDismiss={onDismiss} />)

        fireEvent.animationEnd(toast, { animationName: 'drop-status-out' })
        expect(screen.queryByText(first.message)).toBeNull()
        expect(screen.queryByText(second.message)).not.toBeNull()
    })

    it('unmounts both surfaces immediately when animations are disabled', () => {
        const props = { installing: false, progress: null, gameName: 'PAYDAY 3' }
        const result = { kind: 'done', message: 'Installed test mod' } as const
        const onDismiss = vi.fn()
        animationStyles.textContent = '* { animation-name: none !important; }'
        const overlay = render(<FileDropOverlay {...props} active />)
        const toast = render(<FileDropStatus result={result} onDismiss={onDismiss} />)

        overlay.rerender(<FileDropOverlay {...props} active={false} />)
        toast.rerender(<FileDropStatus result={null} onDismiss={onDismiss} />)
        expect(overlay.container.firstElementChild).toBeNull()
        expect(toast.container.firstElementChild).toBeNull()
    })
})
