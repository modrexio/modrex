// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { MarkdownContent } from './MarkdownContentImpl'
import { api } from '../api'

vi.mock('../api', () => ({ api: { openExternal: vi.fn() } }))

// Mod descriptions come from modworkshop authors, i.e. they are attacker-controlled.
// These tests feed hostile payloads through the full component to pin both layers:
// rehype-sanitize (schema) and the component-level gates (scheme allowlist, embed
// host allowlist).
describe('MarkdownContent sanitization', () => {
    afterEach(() => {
        cleanup()
        vi.clearAllMocks()
    })

    it('strips <script> elements while keeping surrounding text', () => {
        const { container, getByText } = render(
            <MarkdownContent text={'before<script>window.pwned = true</script>after'} />
        )
        expect(container.querySelector('script')).toBeNull()
        expect(getByText(/before/)).toBeTruthy()
        expect(getByText(/after/)).toBeTruthy()
    })

    it('strips inline event handlers but keeps the image', () => {
        const { container } = render(
            <MarkdownContent
                text={'<img src="https://example.com/a.png" onerror="window.pwned = true">'}
            />
        )
        const img = container.querySelector('img')
        expect(img?.getAttribute('src')).toBe('https://example.com/a.png')
        expect(img?.getAttribute('onerror')).toBeNull()
    })

    it('removes style, object, and embed elements', () => {
        const { container } = render(
            <MarkdownContent
                text={
                    '<style>body{display:none}</style><object data="https://example.com/x"></object><embed src="https://example.com/x">'
                }
            />
        )
        expect(container.querySelector('style')).toBeNull()
        expect(container.querySelector('object')).toBeNull()
        expect(container.querySelector('embed')).toBeNull()
    })

    it('renders javascript: links as plain text, not anchors', () => {
        const { container, getByText } = render(
            <MarkdownContent text={'[click me](javascript:alert(1))'} />
        )
        expect(container.querySelector('a')).toBeNull()
        expect(getByText('click me')).toBeTruthy()
    })

    it('routes safe link clicks through the gated external opener', () => {
        const { container } = render(<MarkdownContent text={'[site](https://example.com/)'} />)
        const anchor = container.querySelector('a')
        expect(anchor).not.toBeNull()
        // No real href, so navigation is impossible even if the click handler regressed
        expect(anchor?.getAttribute('href')).toBeNull()
        fireEvent.click(anchor!)
        expect(vi.mocked(api.openExternal)).toHaveBeenCalledWith('https://example.com/')
    })

    it('intercepts modworkshop mod links and triggers onOpenDetail in-app', () => {
        const onOpenDetail = vi.fn()
        const { getByText } = render(
            <MarkdownContent
                text={'[another mod](https://modworkshop.net/mod/45678)'}
                onOpenDetail={onOpenDetail}
            />
        )
        const anchor = getByText('another mod')
        fireEvent.click(anchor)
        expect(onOpenDetail).toHaveBeenCalledWith(45678)
        expect(vi.mocked(api.openExternal)).not.toHaveBeenCalled()
    })

    it('routes non-mod modworkshop links through api.openExternal', () => {
        const onOpenDetail = vi.fn()
        const { getByText } = render(
            <MarkdownContent
                text={'[game page](https://modworkshop.net/game/1)'}
                onOpenDetail={onOpenDetail}
            />
        )
        const anchor = getByText('game page')
        fireEvent.click(anchor)
        expect(onOpenDetail).not.toHaveBeenCalled()
        expect(vi.mocked(api.openExternal)).toHaveBeenCalledWith('https://modworkshop.net/game/1')
    })

    it('drops iframes from hosts outside the embed allowlist', () => {
        const { container } = render(
            <MarkdownContent text={'<iframe src="https://evil.example/payload"></iframe>'} />
        )
        expect(container.querySelector('iframe')).toBeNull()
    })

    it('renders allowlisted video iframes as the click-to-play player, not a live iframe', () => {
        const { container } = render(
            <MarkdownContent
                text={'<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>'}
            />
        )
        expect(container.querySelector('iframe')).toBeNull()
        const thumb = container.querySelector('img')
        expect(thumb?.getAttribute('src')).toBe(
            'https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
        )
    })

    it('keeps modworkshop color tags working', () => {
        const { getByText } = render(<MarkdownContent text={'{#ff0000}(hot text)'} />)
        expect(getByText('hot text').style.color).toBe('rgb(255, 0, 0)')
    })

    // A text color class on strong is a declared property on the element itself, so it
    // always beats an inherited color from an ancestor's inline style and silently drops
    // the color on any bold plus colored combination. strong must carry no color of its
    // own, so it inherits whatever the surrounding text uses.
    it('lets bold text inherit an ancestor color instead of overriding it', () => {
        const { getByText } = render(
            <MarkdownContent text={'<span style="color:green"><strong>bold</strong></span>'} />
        )
        expect(getByText('bold').className).toBe('font-semibold')
    })

    it('handles nested color tags and parentheses', () => {
        const { getByText } = render(
            <MarkdownContent text={'{Red}(outer (text) {#00ff00}(inner))'} />
        )
        expect(getByText(/outer/).style.color).toBe('red')
        expect(getByText('inner').style.color).toBe('rgb(0, 255, 0)')
    })

    it('drops div styles so a description cannot cover the app', () => {
        const { getByText } = render(
            <MarkdownContent
                text={'<div style="position:fixed;inset:0;z-index:99999">fake prompt</div>'}
            />
        )
        expect(getByText('fake prompt').getAttribute('style')).toBeNull()
    })

    it('keeps only the color of a raw span style', () => {
        const { getByText } = render(
            <MarkdownContent
                text={'<span style="color:red;position:fixed;inset:0">overlay</span>'}
            />
        )
        const span = getByText('overlay')
        expect(span.style.color).toBe('red')
        expect(span.style.position).toBe('')
    })

    it('handles long malformed color tags without backtracking', () => {
        const text = '{Red}(' + '()'.repeat(2_000)
        const { container } = render(<MarkdownContent text={text} />)
        expect(container.textContent).toBe(text)
    })

    it('keeps syntax-highlight classes (sanitize must run before rehype-highlight)', () => {
        const { container } = render(<MarkdownContent text={'```js\nconst x = 1\n```'} />)
        expect(container.querySelector('.hljs-keyword')).not.toBeNull()
    })
})
