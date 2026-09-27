import {
    Children,
    cloneElement,
    isValidElement,
    createContext,
    useContext,
    type ReactNode,
} from 'react'
import * as bbcode from 'bbcode-to-react'
import { api } from '../api'
import { parseModworkshopModId } from '../modLinks'
import { YOUTUBE_EMBED } from '../embeds'
import { t } from '../i18n'
import { EmbedPlayer } from './EmbedPlayer'

const NexusNavContext = createContext<((modId: number) => void) | undefined>(undefined)

function NexusAnchor({ href, children }: { href: string; children: ReactNode }) {
    const onOpenDetail = useContext(NexusNavContext)
    const modId = onOpenDetail ? parseModworkshopModId(href) : null

    return (
        // eslint-disable-next-line no-restricted-syntax -- gated: scheme allowlisted, click routed through onOpenDetail or api.openExternal
        <a
            href={href}
            onClick={(e) => {
                e.preventDefault()
                if (modId !== null && onOpenDetail) {
                    onOpenDetail(modId)
                } else {
                    api.openExternal(href)
                }
            }}
            className="text-accent-bright underline cursor-pointer"
        >
            {children}
        </a>
    )
}

// Nexus mod descriptions are BBCode. Parsed here with the actual bbcode-to-react
// library, the same one Nexus's own mod manager Vortex uses (Nexus-Mods/Vortex,
// src/renderer/src/controls/bbcode/), instead of a hand-rolled regex approximation.
// A real tokenizing parser handles malformed input the way Vortex does. Regex can only
// match shapes it was written against.
const { Tag, Parser } = bbcode

// The HTML Latin-1 named references, in code point order from 160 to 255, so the table
// is built by index instead of as 96 hand-paired entries. Mod authors write in many
// languages and their editors escape accented letters this way, so leaving the block out
// would show a literal "&eacute;" in real descriptions. An offset anywhere in the list
// shifts every name after it, which is why the decode test probes across the block
// rather than at one position.
const LATIN1_NAMES =
    'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'.split(
        ' '
    )

// Anything outside these tables and the numeric forms below is left as its literal text,
// which is what a reader of a mod description would rather see than a swallowed
// character.
const NAMED_ENTITIES: Record<string, string> = {
    ...Object.fromEntries(LATIN1_NAMES.map((name, i) => [name, String.fromCodePoint(160 + i)])),
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    ndash: '–',
    mdash: '—',
    hellip: '…',
    lsquo: '‘',
    rsquo: '’',
    ldquo: '“',
    rdquo: '”',
    sbquo: '‚',
    bdquo: '„',
    lsaquo: '‹',
    rsaquo: '›',
    bull: '•',
    dagger: '†',
    Dagger: '‡',
    permil: '‰',
    prime: '′',
    Prime: '″',
    trade: '™',
    euro: '€',
    minus: '−',
    ne: '≠',
    le: '≤',
    ge: '≥',
    infin: '∞',
    larr: '←',
    uarr: '↑',
    rarr: '→',
    darr: '↓',
    harr: '↔',
}

const ENTITY_RE = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g

// Description text is attacker controlled, so a code point out of range or inside the
// surrogate block reaches here from real input, not from a bug. String.fromCodePoint
// throws on the first and produces an unpaired surrogate on the second.
function decodeCodePoint(ref: string): string | null {
    const hex = ref[1] === 'x' || ref[1] === 'X'
    const code = hex ? parseInt(ref.slice(2), 16) : Number(ref.slice(1))
    if (!Number.isInteger(code) || code < 1 || code > 0x10ffff) return null
    if (code >= 0xd800 && code <= 0xdfff) return null
    return String.fromCodePoint(code)
}

// Decoded from an explicit table rather than by writing the text into a detached node's
// innerHTML and reading the parsed value back. That round trip is the idiom CodeQL's
// js/xss-through-dom reports, and it built a throwaway element per call.
function decodeEntities(text: string): string {
    return text.replace(ENTITY_RE, (match, ref: string) => {
        if (ref.startsWith('#')) return decodeCodePoint(ref) ?? match
        return NAMED_ENTITIES[ref] ?? match
    })
}

// Vortex's own preprocessing step: real description data mixes literal br HTML into
// otherwise-BBCode text, normalized into the br tag before parsing. Real Nexus data
// terminates every line with a newline directly followed by a literal br, so the
// newline is swallowed into the same match. Left as a separate text node it breaks the
// block-adjacency check in stripRedundantBreaks below.
function preprocess(text: string): string {
    return decodeEntities(text.replace(/\n?<br\s*\/?>\n?/gi, '[br][/br]'))
}

// Tag.getContent() always HTML-escapes its text (it exists to build a safe HTML
// string for toHTML). toReact has no string to escape into, so a value read this way
// for use as a raw prop (an image src, a bare url) needs the escape undone, or a real
// ampersand in a URL comes back out as the literal text "amp" entity form. Confirmed
// against a live Nexus mod whose button image lost all its styling this way, since its
// colors are set through the query string.
//
// These four are the exact set the library escapes (its ESCAPE_DICT). Undoing only
// them, rather than running the general decoder, keeps an entity that survived
// preprocess as literal text in the source from being decoded a second time here.
const CONTENT_ESCAPES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"' }

function decodeContentEscape(text: string): string {
    return text.replace(/&(amp|lt|gt|quot);/g, (_, name: string) => CONTENT_ESCAPES[name])
}

// Vortex's own br tag, not a bbcode-to-react default.
class BrTag extends Tag {
    toReact() {
        return <br />
    }
}

// Vortex's own size override, a relative scale in rem rather than the base library's
// pixel size.
class SizeTag extends Tag {
    toReact() {
        const size = Number(this.params.size)
        if (Number.isNaN(size)) return Children.toArray(this.getComponents())
        return (
            <span style={{ fontSize: `${1 + size * 0.1}rem` }}>
                {Children.toArray(this.getComponents())}
            </span>
        )
    }
}

class LineTag extends Tag {
    constructor(renderer: unknown, settings: unknown) {
        super(renderer, settings)
        // Nexus emits line without a closing tag. It must not adopt the rest of the
        // description as children and progressively nest every later divider.
        this.SELF_CLOSE = true
        this.STRIP_OUTER = true
    }

    toReact() {
        return <hr />
    }
}

// The library's own code tag prints raw content, which shows preprocess's [br][/br]
// literally and the library's escapes as &quot; and &amp;.
class CodeTag extends Tag {
    toReact() {
        const code = decodeContentEscape(this.getContent(true))
            .replaceAll('[br][/br]', '\n')
            .replace(/^\n+|\n+$/g, '')
        if (this.params.code === 'inline') return <code>{code}</code>
        return (
            <pre>
                <code>{code}</code>
            </pre>
        )
    }
}

class HeadingTag extends Tag {
    toReact() {
        return <h3>{Children.toArray(this.getComponents())}</h3>
    }
}

class FontTag extends Tag {
    toReact() {
        return (
            <span style={{ fontFamily: this.params.font }}>
                {Children.toArray(this.getComponents())}
            </span>
        )
    }
}

class YoutubeTag extends Tag {
    toReact() {
        const value = decodeContentEscape(this.renderer.strip(this.getContent(true)))
        const id =
            YOUTUBE_EMBED.detect(value) ?? (/^[A-Za-z0-9_-]{6,20}$/.test(value) ? value : null)
        if (!id) return Children.toArray(this.getComponents())
        return <EmbedPlayer embed={{ def: YOUTUBE_EMBED, id }} />
    }
}

class SpoilerTag extends Tag {
    toReact() {
        return (
            <details className="my-2 border border-border rounded-lg overflow-hidden">
                <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-text bg-surface-raised hover:bg-surface-hover transition-colors select-none">
                    {this.params.label || t('detail.spoiler')}
                </summary>
                <div className="px-3 py-2">{Children.toArray(this.getComponents())}</div>
            </details>
        )
    }
}

// Overrides the base library's own url, link and email tags (which open a plain
// target blank anchor) to route through api.openExternal instead, matching
// MarkdownContentImpl's own link handling. Mod descriptions are attacker controlled.
class LinkTag extends Tag {
    toReact() {
        // An explicit param (the equals form) comes straight from the raw token and
        // was never escaped. Only the getContent fallback (a bare url with no param)
        // needs the escape undone.
        let url = this.renderer.strip(
            this.params[this.name] || decodeContentEscape(this.getContent(true))
        )
        if (/javascript:/i.test(url)) url = ''
        if (!url.length) return Children.toArray(this.getComponents())
        if (this.name === 'email') url = `mailto:${url}`
        if (!/^(https?|mailto):/i.test(url)) return Children.toArray(this.getComponents())
        return <NexusAnchor href={url}>{this.getComponents()}</NexusAnchor>
    }
}

function imageDimension(value: string | undefined): number | undefined {
    if (!value) return undefined
    const dimension = Number(value)
    if (!Number.isInteger(dimension) || dimension <= 0 || dimension > 4096) return undefined
    return dimension
}

class ImageTag extends Tag {
    constructor(renderer: unknown, settings: unknown) {
        super(renderer, settings)
        // The img=URL form is self-closing, while img with URL content needs its
        // closing tag so the parser can collect that content.
        this.SELF_CLOSE = Boolean(this.params.img)
    }

    toReact() {
        const src = decodeContentEscape(
            this.renderer.strip(this.params.img || this.getContent(true))
        )
        if (!src.length) return null
        if (!/^https?:/i.test(src)) return null

        let layoutClass = 'inline-block'
        switch (this.params.align?.toLowerCase()) {
            case 'center':
                layoutClass = 'block mx-auto'
                break
            case 'right':
                layoutClass = 'block ml-auto'
                break
            case 'left':
                layoutClass = 'block mr-auto'
                break
        }

        return (
            <img
                src={src}
                alt=""
                loading="lazy"
                width={imageDimension(this.params.width)}
                height={imageDimension(this.params.height)}
                className={[layoutClass, 'max-w-full h-auto rounded my-2'].join(' ')}
            />
        )
    }
}

const parser = new Parser()
parser.registerTag('br', BrTag)
parser.registerTag('size', SizeTag)
parser.registerTag('line', LineTag)
parser.registerTag('code', CodeTag)
parser.registerTag('heading', HeadingTag)
parser.registerTag('font', FontTag)
parser.registerTag('youtube', YoutubeTag)
parser.registerTag('spoiler', SpoilerTag)
parser.registerTag('url', LinkTag)
parser.registerTag('link', LinkTag)
parser.registerTag('email', LinkTag)
parser.registerTag('img', ImageTag)

// A br immediately next to a block element's boundary is dead space, since the block
// already starts its own line. Confirmed against a real mod description where this
// doubled the visible spacing between every section.
const BLOCK_TYPES = new Set([
    'div',
    'blockquote',
    'details',
    'figure',
    'ul',
    'ol',
    'li',
    'hr',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'pre',
    'table',
])

function isBr(node: ReactNode): boolean {
    return isValidElement(node) && node.type === 'br'
}

function isBlock(node: ReactNode): boolean {
    return isValidElement(node) && typeof node.type === 'string' && BLOCK_TYPES.has(node.type)
}

function stripRedundantBreaks(nodes: ReactNode[]): ReactNode[] {
    return nodes.filter(
        (node, i) => !isBr(node) || (!isBlock(nodes[i - 1]) && !isBlock(nodes[i + 1]))
    )
}

function stripTrailingBreaks(nodes: ReactNode[]): ReactNode[] {
    const result = [...nodes]
    while (isBr(result.at(-1))) result.pop()
    return result
}

function normalizeNode(node: ReactNode): ReactNode {
    if (!isValidElement<{ children?: ReactNode }>(node)) return node
    if (node.props.children === undefined) return node

    let children = normalizeNodes(Children.toArray(node.props.children))
    if (node.type === 'li') children = stripTrailingBreaks(children)
    return cloneElement(node, undefined, children)
}

function normalizeNodes(nodes: ReactNode[]): ReactNode[] {
    return stripRedundantBreaks(nodes.map(normalizeNode))
}

export function NexusDescription({
    text,
    onOpenDetail,
}: {
    text: string
    onOpenDetail?: (modId: number) => void
}) {
    const nodes = Children.toArray(parser.toReact(preprocess(text)))
    return (
        <NexusNavContext.Provider value={onOpenDetail}>
            <div className="nexus-description">{normalizeNodes(nodes)}</div>
        </NexusNavContext.Provider>
    )
}
