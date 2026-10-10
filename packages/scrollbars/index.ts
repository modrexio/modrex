import { OverlayScrollbars, type PartialOptions } from 'overlayscrollbars'

const scrollbars: PartialOptions['scrollbars'] = {
    theme: 'os-theme-modrex',
    autoHide: 'move',
    autoHideDelay: 800,
    clickScroll: 'instant',
}

const axis = (overflow: string) => (/auto|scroll/.test(overflow) ? 'scroll' : 'hidden')

/** Keeps the scrollbar outside its native scrolling viewport. */
export function overlayScrollbar(viewport: HTMLElement, host: HTMLElement) {
    const { overflowX, overflowY } = getComputedStyle(viewport)
    return OverlayScrollbars(
        { target: viewport, elements: { viewport }, scrollbars: { slot: host } },
        { overflow: { x: axis(overflowX), y: axis(overflowY) }, scrollbars }
    )
}

const hosts = new WeakMap<HTMLElement, HTMLElement>()

function attach(el: Element, ignore?: string) {
    if (!(el instanceof HTMLElement) || el instanceof HTMLTextAreaElement) return
    if (ignore && el.closest(ignore)) return
    if (OverlayScrollbars(el)) return
    const { overflowX, overflowY, flex, position } = getComputedStyle(el)
    if (!/auto|scroll/.test(overflowX + overflowY)) return
    // Wrapping fixed or absolute panes breaks their positioning and sibling selectors.
    if (position === 'fixed' || position === 'absolute') return
    const host = document.createElement('div')
    host.className = 'modrex-scrollbar-host'
    host.style.flex = flex
    el.before(host)
    host.append(el)
    hosts.set(el, host)
    overlayScrollbar(el, host)
}

function detach(el: Element) {
    if (el.isConnected || !(el instanceof HTMLElement)) return
    OverlayScrollbars(el)?.destroy()
    hosts.get(el)?.remove()
    hosts.delete(el)
}

const subtree = (node: Node) =>
    node instanceof Element ? [node, ...node.querySelectorAll('*')] : []

/** Gives the page scroll the shared overlay scrollbar. */
export function overlayPageScrollbar() {
    OverlayScrollbars(document.body, { scrollbars })
}

/**
 * Wraps static page scroll containers, except those matching or inside ignore, as they mount.
 * React content supplies its own host through overlayScrollbar to preserve DOM ownership.
 */
export function overlayScrollContainers(ignore?: string) {
    const attachAll = (node: Node) => subtree(node).forEach((el) => attach(el, ignore))
    attachAll(document.body)
    new MutationObserver((records) => {
        for (const r of records) r.removedNodes.forEach((n) => subtree(n).forEach(detach))
        for (const r of records) r.addedNodes.forEach(attachAll)
    }).observe(document.body, { childList: true, subtree: true })
}
