// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { NexusDescription } from './NexusDescription'
import { api } from '../api'

vi.mock('../api', () => ({ api: { openExternal: vi.fn() } }))

describe('NexusDescription', () => {
    it('renders bold, italic, underline and strike', () => {
        const { getByText } = render(
            <NexusDescription text="[b]bold[/b] [i]italic[/i] [u]under[/u] [s]strike[/s]" />
        )
        expect(getByText('bold').tagName).toBe('STRONG')
        // bbcode-to-react's own default tag: [i] maps to <em>, not <i>.
        expect(getByText('italic').tagName).toBe('EM')
        expect(getByText('under').tagName).toBe('U')
        // bbcode-to-react's own default tag: [s] maps to <strike>, not <s>.
        expect(getByText('strike').tagName).toBe('STRIKE')
    })

    it('lets bold text inherit an ancestor color instead of overriding it', () => {
        const { getByText } = render(<NexusDescription text="[color=green][b]text[/b][/color]" />)
        const bold = getByText('text')
        expect(bold.style.color).toBe('')
        expect(bold.closest('span')?.style.color).toBe('green')
    })

    it('sizes [size] text like the Nexus site does', () => {
        const { getByText } = render(
            <NexusDescription text="[size=2]fine print[/size][size=4]big[/size][size=200]huge[/size]" />
        )
        expect(getByText('fine print').style.fontSize).toBe('13px')
        expect(getByText('big').style.fontSize).toBe('18px')
        expect(getByText('huge').style.fontSize).toBe('48px')
    })

    it('normalizes a literal <br> into a real line break with no doubling', () => {
        const { container } = render(<NexusDescription text={'one\n<br />two'} />)
        expect(container.querySelectorAll('br')).toHaveLength(1)
    })

    it('centers a [center] block including an image inside it', () => {
        const { container } = render(
            <NexusDescription text="[center][url=https://x.test][img]https://x.test/a.png[/img][/url][/center]" />
        )
        const img = container.querySelector('img')
        const centered = container.querySelector('div[style*="center"]')
        expect(centered?.contains(img)).toBe(true)
        expect(img?.classList.contains('inline-block')).toBe(true)
    })

    it('renders a [left] block instead of leaking the tag', () => {
        const { container, getByText } = render(
            <NexusDescription text="[center]Intro[/center][left][i]Aligned[/i][/left]" />
        )
        expect(getByText('Aligned').closest('div')?.style.textAlign).toBe('left')
        expect(container.textContent).toBe('IntroAligned')
    })

    it('supports a self-closing image URL with dimensions and alignment', () => {
        const { container, getByText } = render(
            <NexusDescription text="[img=https://x.test/a.png width=640 height=360 align=center]after" />
        )
        const img = container.querySelector('img')
        expect(img?.getAttribute('src')).toBe('https://x.test/a.png')
        expect(img?.getAttribute('width')).toBe('640')
        expect(img?.getAttribute('height')).toBe('360')
        expect(img?.classList.contains('mx-auto')).toBe(true)
        expect(getByText('after')).toBeDefined()
    })

    it('ignores invalid image dimensions', () => {
        const { container } = render(
            <NexusDescription text="[img width=-1 height=99999]https://x.test/a.png[/img]" />
        )
        const img = container.querySelector('img')
        expect(img?.hasAttribute('width')).toBe(false)
        expect(img?.hasAttribute('height')).toBe(false)
    })

    it('renders a list with no cross-item contamination', () => {
        const { container, getByText } = render(
            <NexusDescription text="[list][*]one[*]two[*]three[/list]" />
        )
        expect(container.querySelectorAll('li')).toHaveLength(3)
        expect(getByText('one').tagName).toBe('LI')
        expect(getByText('two').tagName).toBe('LI')
        expect(getByText('three').tagName).toBe('LI')
    })

    it('removes Nexus line terminators from list item boundaries', () => {
        const { container } = render(
            <NexusDescription text={'[list]\n<br />[*]Joy\n<br />[*]Pearl\n<br />[/list]'} />
        )
        expect(container.querySelectorAll('li')).toHaveLength(2)
        expect(container.querySelectorAll('li br')).toHaveLength(0)
        expect(container.querySelectorAll('ul > br')).toHaveLength(0)
    })

    // The bug this catches: the old regex converter matched a list item up to the next
    // literal bracket, so an item with a stray bracket in its own content leaked an
    // unbalanced fragment that markdown's emphasis parser then picked up, alternating
    // italics across unrelated sibling items. A real tokenizing parser can't leak this
    // way, since an unrecognized tag is just a text node in the right place.
    it('does not let a stray bracket in one list item corrupt a sibling item', () => {
        const { getByText } = render(
            <NexusDescription text="[list][*]stealth patrol [/][*]snipers[*]cam angles[/list]" />
        )
        expect(getByText(/snipers/).tagName).toBe('LI')
        expect(getByText(/cam angles/).tagName).toBe('LI')
        expect(getByText(/snipers/).tagName).not.toBe('EM')
        expect(getByText(/cam angles/).tagName).not.toBe('EM')
    })

    it('routes a link click through api.openExternal instead of navigating directly', () => {
        const { getByText } = render(<NexusDescription text="[url=https://x.test]click[/url]" />)
        const a = getByText('click')
        expect(a.tagName).toBe('A')
        expect(a.getAttribute('href')).toBe('https://x.test')
        fireEvent.click(a)
        expect(vi.mocked(api.openExternal)).toHaveBeenCalledWith('https://x.test')
    })

    it('intercepts modworkshop mod links and calls onOpenDetail', () => {
        const onOpenDetail = vi.fn()
        const { getByText } = render(
            <NexusDescription
                text="[url=https://modworkshop.net/mod/54321]view mod[/url]"
                onOpenDetail={onOpenDetail}
            />
        )
        const a = getByText('view mod')
        fireEvent.click(a)
        expect(onOpenDetail).toHaveBeenCalledWith(54321)
    })

    // Tag.getContent() always HTML-escapes its text, so a bare-URL image or link with
    // no equals param comes back with any real ampersand turned into a literal entity
    // unless that's undone. Confirmed against a real Nexus mod whose donation button
    // image lost all its styling this way, since its colors are set through the query
    // string and the entity broke the server's own parsing of it.
    it('does not leave a literal "&amp;" in a bare-URL image src', () => {
        const { container } = render(
            <NexusDescription text="[img]https://x.test/a.png?a=1&amp;b=2[/img]" />
        )
        const src = container.querySelector('img')?.getAttribute('src')
        expect(src).toBe('https://x.test/a.png?a=1&b=2')
    })

    it('does not leave a literal "&amp;" in a bare [url] with no display text', () => {
        const { getByText } = render(
            <NexusDescription text="[url]https://x.test/a?a=1&amp;b=2[/url]" />
        )
        expect(getByText(/x\.test/).getAttribute('href')).toBe('https://x.test/a?a=1&b=2')
    })

    it('decodes named and numeric entities in description prose', () => {
        const { container } = render(
            <NexusDescription text="Tom&rsquo;s mod &mdash; 100&#37; &#x2192; done &copy;" />
        )
        expect(container.textContent).toBe('Tom’s mod — 100% → done ©')
    })

    // The Latin-1 table is built by index from one ordered name list, so a missing or
    // transposed name shifts every entry after it. These probe near both ends and three
    // interior positions, which no single-point offset can pass. The name at index 0 is
    // nbsp, deliberately not asserted here so the file carries no invisible character.
    it('decodes the Latin-1 named entities across the whole block', () => {
        const { container } = render(
            <NexusDescription text="&iexcl;|&reg;|&Agrave;|&eacute;|&uuml;|&yuml;" />
        )
        expect(container.textContent).toBe('¡|®|À|é|ü|ÿ')
    })

    it('leaves an unknown or malformed entity as its literal text', () => {
        const { container } = render(
            <NexusDescription text="&notreal; &#xD800; &#1114112; &amp;notreal;" />
        )
        expect(container.textContent).toBe('&notreal; &#xD800; &#1114112; &notreal;')
    })

    // The general decoder must not run on content read back through getContent, or an
    // entity the author wrote as literal text (escaped at the source as "&amp;copy;")
    // would be decoded a second time and turn into the character.
    it('does not double-decode an entity that is literal text inside a url', () => {
        const { container } = render(
            <NexusDescription text="[url]https://x.test/a?q=&amp;amp;copy;[/url]" />
        )
        expect(container.querySelector('a')?.getAttribute('href')).toBe('https://x.test/a?q=&copy;')
    })

    // A br touching a block element's boundary is dead space, since the block already
    // starts its own line. Confirmed by a real regression where this doubled the total
    // break count for a real mod's full description.
    it('drops a <br/> that sits directly next to a block element', () => {
        const { container } = render(
            <NexusDescription text={'before\n<br />[center]centered[/center]\n<br />after'} />
        )
        expect(container.querySelectorAll('br')).toHaveLength(0)
    })

    it('keeps a <br/> between two pieces of inline content', () => {
        const { container } = render(<NexusDescription text={'one\n<br />two'} />)
        expect(container.querySelectorAll('br')).toHaveLength(1)
    })

    it('treats consecutive [line] tags as sibling horizontal rules', () => {
        const { container } = render(<NexusDescription text="[line]first[line]second" />)
        expect(container.querySelectorAll('.nexus-description > hr')).toHaveLength(2)
        expect(container.textContent).toBe('firstsecond')
    })

    it('renders Nexus heading and font tags', () => {
        const { getByText } = render(
            <NexusDescription text="[heading]Title[/heading][font=Impact]Body[/font]" />
        )
        expect(getByText('Title').tagName).toBe('H3')
        expect(getByText('Body').style.fontFamily).toBe('Impact')
    })

    it('renders a Nexus spoiler as an expandable details element', () => {
        const { getByText } = render(
            <NexusDescription text="[spoiler label=Details]Hidden[/spoiler]" />
        )
        expect(getByText('Details').tagName).toBe('SUMMARY')
        expect(getByText('Hidden').closest('details')).not.toBeNull()
    })

    it('renders a Nexus YouTube tag through the shared embed player', () => {
        const { container } = render(<NexusDescription text="[youtube]dQw4w9WgXcQ[/youtube]" />)
        expect(
            container.querySelector(
                'img[src="https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg"]'
            )
        ).not.toBeNull()
        expect(container.querySelector('iframe')).toBeNull()
    })

    it('keeps line breaks and quotes inside a code block', () => {
        const { container } = render(
            <NexusDescription
                text={
                    '[code]Mods&#92;\n<br />└── main.lua\n<br />["id"] = a &lt; b &amp;&amp; c[/code]'
                }
            />
        )
        expect(container.querySelector('pre > code')?.textContent).toBe(
            'Mods\\\n└── main.lua\n["id"] = a < b && c'
        )
    })

    it('renders [code=inline] as inline code', () => {
        const { container } = render(<NexusDescription text="run [code=inline]a && b[/code] now" />)
        expect(container.querySelector('pre')).toBeNull()
        expect(container.querySelector('code')?.textContent).toBe('a && b')
    })

    it('preserves semantic table markup for scoped description styling', () => {
        const { getByText } = render(
            <NexusDescription text="[table][tr][th]Name[/th][td]Value[/td][/tr][/table]" />
        )
        expect(getByText('Name').tagName).toBe('TH')
        expect(getByText('Value').tagName).toBe('TD')
    })

    it('keeps Nexus line breaks out of the table structure', () => {
        const { container } = render(
            <NexusDescription
                text={
                    '[table]\n<br />[tr]\n<br />[td]a[/td]\n<br />[td]b[/td]\n<br />[/tr]\n<br />[/table]'
                }
            />
        )
        expect(container.querySelectorAll('table br')).toHaveLength(0)
        expect(container.querySelectorAll('td')).toHaveLength(2)
    })
})
