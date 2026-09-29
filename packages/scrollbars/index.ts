import { OverlayScrollbars, type PartialOptions } from 'overlayscrollbars'

const scrollbars: PartialOptions['scrollbars'] = {
    theme: 'os-theme-modrex',
    autoHide: 'move',
    autoHideDelay: 800,
    clickScroll: 'instant',
}

const axis = (overflow: string) => (/auto|scroll/.test(overflow) ? 'scroll' : 'hidden')

function attach(el: Element, ignore?: string) {
    // A textarea cannot hold the scrollbar elements.
    if (!(el instanceof HTMLElement) || el instanceof HTMLTextAreaElement) return
    if (ignore && el.closest(ignore)) return
    const { overflowX, overflowY } = getComputedStyle(el)
    if (!/auto|scroll/.test(overflowX + overflowY)) return
    OverlayScrollbars(
        { target: el, elements: { viewport: el } },
        { overflow: { x: axis(overflowX), y: axis(overflowY) }, scrollbars }
    )
}

function detach(el: Element) {
    if (el.isConnected || !(el instanceof HTMLElement)) return
    OverlayScrollbars(el)?.destroy()
}

const subtree = (node: Node) =>
    node instanceof Element ? [node, ...node.querySelectorAll('*')] : []

/** Gives the page scroll the shared overlay scrollbar. */
export function overlayPageScrollbar() {
    OverlayScrollbars(document.body, { scrollbars })
}

/**
 * Gives every scroll container in the document the shared overlay scrollbar, now and as they mount.
 * Containers matching or inside ignore keep their native scrollbar.
 */
export function overlayScrollContainers(ignore?: string) {
    const attachAll = (node: Node) => subtree(node).forEach((el) => attach(el, ignore))
    attachAll(document.body)
    new MutationObserver((records) => {
        for (const r of records) r.removedNodes.forEach((n) => subtree(n).forEach(detach))
        for (const r of records) r.addedNodes.forEach(attachAll)
    }).observe(document.body, { childList: true, subtree: true })
}
