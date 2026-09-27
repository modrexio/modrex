// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { MarkdownContent, ModworkshopMarkup } from './MarkdownContentImpl'
import { api } from '../api'

vi.mock('../api', () => ({ api: { openExternal: vi.fn() } }))

const YOUTUBE_THUMB = 'img[src="https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg"]'

afterEach(() => {
    cleanup()
    vi.clearAllMocks()
})

// Mod descriptions come from modworkshop authors, i.e. they are attacker-controlled.
// These tests feed hostile payloads through the full component to pin every layer:
// markdown-it escaping raw HTML, rehype-sanitize, and the component-level gates.
describe('ModworkshopMarkup sanitization', () => {
    it('shows raw HTML as text instead of rendering it', () => {
        const { container } = render(
            <ModworkshopMarkup
                text={
                    'before<script>window.pwned = true</script>after <img src="https://example.com/a.png" onerror="window.pwned = true">'
                }
            />
        )
        expect(container.querySelector('script')).toBeNull()
        expect(container.querySelector('img')).toBeNull()
        expect(container.textContent).toContain('<img src=')
    })

    it('cannot draw over the app with raw styled markup', () => {
        const { container } = render(
            <ModworkshopMarkup
                text={'<div style="position:fixed;inset:0;z-index:99999">fake prompt</div>'}
            />
        )
        expect(container.querySelector('[style*="fixed"]')).toBeNull()
    })

    it('removes style, object, and embed elements', () => {
        const { container } = render(
            <ModworkshopMarkup
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
        const { container } = render(<ModworkshopMarkup text={'[click me](javascript:alert(1))'} />)
        expect(container.querySelector('a')).toBeNull()
        expect(container.textContent).toContain('click me')
    })

    it('routes safe link clicks through the gated external opener', () => {
        const { container } = render(<ModworkshopMarkup text={'[site](https://example.com/)'} />)
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
            <ModworkshopMarkup
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
            <ModworkshopMarkup
                text={'[game page](https://modworkshop.net/game/1)'}
                onOpenDetail={onOpenDetail}
            />
        )
        const anchor = getByText('game page')
        fireEvent.click(anchor)
        expect(onOpenDetail).not.toHaveBeenCalled()
        expect(vi.mocked(api.openExternal)).toHaveBeenCalledWith('https://modworkshop.net/game/1')
    })

    it('never renders a raw iframe', () => {
        const { container } = render(
            <ModworkshopMarkup
                text={'<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>'}
            />
        )
        expect(container.querySelector('iframe')).toBeNull()
    })
})

describe('ModworkshopMarkup embeds', () => {
    it('renders a video image as the click-to-play player, not a live iframe', () => {
        const { container } = render(
            <ModworkshopMarkup text={'![](https://www.youtube.com/watch?v=dQw4w9WgXcQ)'} />
        )
        expect(container.querySelector('iframe')).toBeNull()
        expect(container.querySelector(YOUTUBE_THUMB)).not.toBeNull()
    })

    it('embeds a video inside a spoiler', () => {
        const { container } = render(
            <ModworkshopMarkup text={'!!!Videos\n![](https://youtu.be/dQw4w9WgXcQ)\n!!!'} />
        )
        expect(container.querySelector(`details ${YOUTUBE_THUMB}`)).not.toBeNull()
    })

    it('keeps a quoted video inside its quote', () => {
        const { container } = render(
            <ModworkshopMarkup text={'> ![](https://www.youtube.com/watch?v=dQw4w9WgXcQ)'} />
        )
        expect(container.querySelector(`blockquote ${YOUTUBE_THUMB}`)).not.toBeNull()
    })

    it('keeps the rest of a table after a video cell', () => {
        const { container } = render(
            <ModworkshopMarkup
                text={'| a | b |\n|---|---|\n| x | ![](https://youtu.be/dQw4w9WgXcQ) |\n| y | z |'}
            />
        )
        expect(container.querySelectorAll('tbody tr')).toHaveLength(2)
        expect(container.querySelector(`td ${YOUTUBE_THUMB}`)).not.toBeNull()
    })
})

describe('ModworkshopMarkup spoilers', () => {
    it('uses the text after the markers as the title', () => {
        const { getByText } = render(<ModworkshopMarkup text={'!!! Changes\nbody\n!!!'} />)
        expect(getByText('Changes').tagName).toBe('SUMMARY')
        expect(getByText('body').closest('details')).not.toBeNull()
    })

    it('closes on a longer marker run and falls back to the default title', () => {
        const { container } = render(<ModworkshopMarkup text={'!!!!\nbody\n!!!!'} />)
        expect(container.querySelector('summary')?.textContent).toBe('Spoiler!')
        expect(container.textContent).not.toContain('!!!!')
    })

    it('reads !!!text!!! on one line as a spoiler', () => {
        const { getByText } = render(<ModworkshopMarkup text={'!!!secret!!!'} />)
        expect(getByText('secret').closest('details')).not.toBeNull()
    })

    it('runs an unclosed spoiler to the end of the text', () => {
        const { getByText } = render(<ModworkshopMarkup text={'intro\n\n!!!Title\nbody to end'} />)
        expect(getByText('body to end').closest('details')).not.toBeNull()
        expect(getByText('intro').closest('details')).toBeNull()
    })

    it('leaves markers inside a code block alone', () => {
        const { container } = render(
            <ModworkshopMarkup text={'```\n!!!\nnot a spoiler\n!!!\n```'} />
        )
        expect(container.querySelector('details')).toBeNull()
        expect(container.querySelector('pre')?.textContent).toContain('!!!')
    })
})

describe('ModworkshopMarkup centering', () => {
    // GIVE ME THE POWER (modworkshop 57954) opens like this. Without ::: blocks the
    // ---- under the text turned both lines into a heading.
    it('centers ::: lines and keeps the rule under them', () => {
        const { container, getByText } = render(
            <ModworkshopMarkup
                text={
                    ':::![](https://storage.modworkshop.net/mods/images/logo.webp):::\n----\n:::is a simple mod:::\n::: Rebalancing most of them.:::'
                }
            />
        )
        expect(container.querySelector('h2')).toBeNull()
        expect(container.querySelectorAll('hr')).toHaveLength(1)
        expect(container.querySelector('.text-center img')).not.toBeNull()
        expect(getByText('is a simple mod').className).toBe('text-center [&_div]:mx-auto')
        expect(getByText('Rebalancing most of them.')).toBeTruthy()
        expect(container.textContent).not.toContain(':::')
    })

    it('centers a ::: block across several lines', () => {
        const { getByText } = render(<ModworkshopMarkup text={'::::::\n**centered**\n::::::'} />)
        expect(getByText('centered').closest('.text-center')).not.toBeNull()
    })
})

describe('ModworkshopMarkup formatting', () => {
    it('keeps modworkshop color tags working', () => {
        const { getByText } = render(<ModworkshopMarkup text={'{#ff0000}(hot text)'} />)
        expect(getByText('hot text').style.color).toBe('rgb(255, 0, 0)')
    })

    // A text color class on strong is a declared property on the element itself, so it
    // always beats an inherited color from an ancestor's inline style and silently drops
    // the color on any bold plus colored combination. strong must carry no color of its
    // own, so it inherits whatever the surrounding text uses.
    it('lets bold text inherit an ancestor color instead of overriding it', () => {
        const { getByText } = render(<ModworkshopMarkup text={'{green}(**bold**)'} />)
        expect(getByText('bold').className).toBe('font-semibold')
        expect(getByText('bold').closest('span')?.style.color).toBe('green')
    })

    it('handles nested color tags and parentheses', () => {
        const { getByText } = render(
            <ModworkshopMarkup text={'{Red}(outer (text) {#00ff00}(inner))'} />
        )
        expect(getByText(/outer/).style.color).toBe('red')
        expect(getByText('inner').style.color).toBe('rgb(0, 255, 0)')
    })

    it('drops hex colors too dark to read, like ModWorkshop does', () => {
        const { getByText } = render(
            <ModworkshopMarkup text={'{#000000}(black) {#333}(grey) {#5a8dee}(blue)'} />
        )
        expect(getByText('black').style.color).toBe('')
        expect(getByText('grey').style.color).toBe('')
        expect(getByText('blue').style.color).toBe('rgb(90, 141, 238)')
    })

    it('leaves color tags inside code alone', () => {
        const { container } = render(<ModworkshopMarkup text={'```lua\nlocal c = {red}(x)\n```'} />)
        expect(container.querySelector('pre')?.textContent).toContain('{red}(x)')
        expect(container.querySelector('[style]')).toBeNull()
    })

    it('handles long malformed color tags without backtracking', () => {
        const text = '{Red}(' + '()'.repeat(2_000)
        const { container } = render(<ModworkshopMarkup text={text} />)
        expect(container.textContent?.trim()).toBe(text)
    })

    it('keeps syntax-highlight classes (sanitize must run before rehype-highlight)', () => {
        const { container } = render(<ModworkshopMarkup text={'```js\nconst x = 1\n```'} />)
        expect(container.querySelector('.hljs-keyword')).not.toBeNull()
    })

    it('keeps table column alignment', () => {
        const { getByText } = render(<ModworkshopMarkup text={'| n |\n|--:|\n| 1 |'} />)
        expect(getByText('1').style.textAlign).toBe('right')
    })

    it('underlines __text__ and keeps **text** bold', () => {
        const { getByText } = render(<ModworkshopMarkup text={'__under__ and **bold**'} />)
        expect(getByText('under').tagName).toBe('U')
        expect(getByText('bold').tagName).toBe('STRONG')
    })
})

describe('ModworkshopMarkup mentions', () => {
    it('links @name to the user on ModWorkshop', () => {
        const { getByText } = render(<ModworkshopMarkup text={'thanks @some_one for help'} />)
        const anchor = getByText('@some_one')
        expect(anchor.tagName).toBe('A')
        fireEvent.click(anchor)
        expect(vi.mocked(api.openExternal)).toHaveBeenCalledWith(
            'https://modworkshop.net/user/some_one'
        )
    })

    it('leaves an @ inside a word or address alone', () => {
        const { container } = render(
            <ModworkshopMarkup text={'mail me at author@site and see a@b'} />
        )
        expect(container.querySelector('a')).toBeNull()
    })
})

describe('MarkdownContent', () => {
    it('reads text as plain markdown, without ModWorkshop syntax', () => {
        const { getByText, container } = render(
            <MarkdownContent text={'__bold__ {red}(not a color) :::not centered::: @nobody'} />
        )
        expect(container.querySelector('a')).toBeNull()
        expect(getByText('bold').tagName).toBe('STRONG')
        expect(container.querySelector('[style]')).toBeNull()
        expect(container.textContent).toContain(':::not centered:::')
    })
})
