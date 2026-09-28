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

describe('ModworkshopMarkup media', () => {
    // (UE5) Escape From Tarkov Cops & (male) Heisters VO, modworkshop 59215.
    it('embeds a SoundCloud track behind click-to-play', () => {
        const { container } = render(
            <ModworkshopMarkup
                text={'![Cops & SWAT](https://soundcloud.com/kazmer-337245286/02-cops-and-swat-2)'}
            />
        )
        expect(container.querySelector('img')).toBeNull()
        fireEvent.click(container.querySelector('button')!)
        expect(container.querySelector('iframe')?.getAttribute('src')).toBe(
            'https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fkazmer-337245286%2F02-cops-and-swat-2&auto_play=true'
        )
    })

    it('embeds a Vimeo video', () => {
        const { container } = render(<ModworkshopMarkup text={'![](https://vimeo.com/76979871)'} />)
        fireEvent.click(container.querySelector('button')!)
        expect(container.querySelector('iframe')?.getAttribute('src')).toBe(
            'https://player.vimeo.com/video/76979871?autoplay=1'
        )
    })

    it('embeds a streamable.com/e/ link', () => {
        const { container } = render(
            <ModworkshopMarkup text={'![](https://streamable.com/e/u8nid1)'} />
        )
        expect(
            container.querySelector(
                'img[src="https://cdn-cf-east.streamable.com/image/u8nid1.jpg"]'
            )
        ).not.toBeNull()
    })

    it('plays linked video and audio files in place', () => {
        const { container } = render(
            <ModworkshopMarkup
                text={'![](https://files.catbox.moe/1bdqjs.mp4)\n![](https://x.test/song.MP3)'}
            />
        )
        expect(container.querySelector('video')?.getAttribute('src')).toBe(
            'https://files.catbox.moe/1bdqjs.mp4'
        )
        expect(container.querySelector('audio')?.getAttribute('src')).toBe(
            'https://x.test/song.MP3'
        )
        expect(container.querySelector('img')).toBeNull()
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

describe('ModworkshopMarkup legacy text', () => {
    // Opening of Meth Helper Updated (modworkshop 25950), still on the legacy parser.
    const METH_HELPER =
        "An updated version of Kangaroo's [url=http://modwork.shop/14050]Meth Helper[/url].\n\n[hr]\n\n### [color=ffd700]About This Mod[/color]\n\n[b]Meth Helper Updated[/b] can display:\n[list]\n[*]The next ingredient\n[*]Which ingredients were added\n[/list]"

    it('renders BBCode mixed into markdown', () => {
        const { container, getByText } = render(
            <ModworkshopMarkup text={METH_HELPER} legacy onOpenDetail={vi.fn()} />
        )
        expect(getByText('Meth Helper').tagName).toBe('A')
        expect(container.querySelector('hr')).not.toBeNull()
        expect(getByText('About This Mod').style.color).toBe('rgb(255, 215, 0)')
        expect(getByText('Meth Helper Updated').tagName).toBe('STRONG')
        expect(container.querySelectorAll('ul li')).toHaveLength(2)
        expect(container.textContent).not.toMatch(/\[\/?(url|hr|color|b|list|\*)/)
    })

    it('shows the same text literally on the current parser', () => {
        const { container } = render(<ModworkshopMarkup text={'[b]plain[/b]'} />)
        expect(container.textContent).toContain('[b]plain[/b]')
    })

    it('reads ||text|| as a spoiler', () => {
        const { getByText } = render(<ModworkshopMarkup text={'||\nhidden\n||'} legacy />)
        expect(getByText('hidden').closest('details')).not.toBeNull()
    })

    it('centers :::text::: even inside a heading', () => {
        const { getByText } = render(
            <ModworkshopMarkup text={'# :::**Installation**:::\n\n:::Extract it:::'} legacy />
        )
        expect(getByText('Installation').closest('h1 .text-center')).not.toBeNull()
        expect(getByText('Extract it').className).toBe('block text-center')
    })

    it('leaves unpaired tags as written and repairs crossed ones', () => {
        const { container, getByText } = render(
            <ModworkshopMarkup
                text={'[u]never closed [b]open and [i]crossed[/b] after[/i]'}
                legacy
            />
        )
        expect(container.textContent?.trim()).toBe('[u]never closed open and crossed after')
        expect(getByText('crossed').tagName).toBe('EM')
        expect(getByText('crossed').parentElement?.tagName).toBe('STRONG')
    })

    it('still shows raw HTML as text', () => {
        const { container } = render(<ModworkshopMarkup text={'<b>x</b> [b]y[/b]'} legacy />)
        expect(container.querySelector('b')).toBeNull()
        expect(container.textContent).toContain('<b>x</b>')
    })

    it('cannot break out of a tag attribute', () => {
        const { container } = render(
            <ModworkshopMarkup
                text={
                    '[url=https://x.test" onmouseover="alert(1)]link[/url][img=a" onerror="alert(1)]https://x.test/a.png[/img]'
                }
                legacy
            />
        )
        expect(container.querySelector('[onmouseover], [onerror]')).toBeNull()
    })

    it('renders images, videos, code and sizes', () => {
        const { container, getByText } = render(
            <ModworkshopMarkup
                text={
                    '[img]https://x.test/a.png[/img]\n[video=youtube]dQw4w9WgXcQ[/video]\n[code]a\nb[/code]\n[size=large]big[/size]'
                }
                legacy
            />
        )
        expect(container.querySelector('img[src="https://x.test/a.png"]')).not.toBeNull()
        expect(container.querySelector(YOUTUBE_THUMB)).not.toBeNull()
        expect(container.querySelector('pre')?.textContent).toBe('a\nb')
        expect(getByText('big').style.fontSize).toBe('large')
    })

    it('drops a hex color too dark to read, like the legacy parser', () => {
        const { getByText } = render(
            <ModworkshopMarkup text={'[color=#111111]dark[/color] [color=red]red[/color]'} legacy />
        )
        expect(getByText(/dark/).style.color).toBe('')
        expect(getByText('red').style.color).toBe('red')
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
