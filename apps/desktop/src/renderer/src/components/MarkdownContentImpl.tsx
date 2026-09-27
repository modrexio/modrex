import { useMemo, createContext, useContext, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import type { Components } from 'react-markdown'
import { t } from '../i18n'
import { detectEmbed, EMBEDS, type Embed, type EmbedDef } from '../embeds'
import 'highlight.js/styles/github-dark.css'
import { api } from '../api'
import { parseModworkshopModId } from '../modLinks'
import { EmbedPlayer } from './EmbedPlayer'

const InsidePreContext = createContext(false)

// Mod descriptions are attacker-controlled HTML (rehypeRaw), so they are sanitized
// against the GitHub-style default schema. Must run AFTER rehypeRaw (there is no raw
// HTML to sanitize before it) and BEFORE rehypeHighlight (so the hljs-* classes it
// injects survive). Two deliberate carve-outs beyond the defaults:
// - span keeps the style attribute: parseColorTags compiles modworkshop's {#hex}(text)
//   syntax to <span style="color:...">. The span component below keeps only color,
//   so a description can't position anything over the app.
// - iframe keeps only src (http/https enforced by the schema's protocol map): the
//   iframe component below renders nothing unless detectEmbed matches an allowlisted
//   video host, so unknown iframes are dropped even after passing sanitization.
const sanitizeSchema = {
    ...defaultSchema,
    tagNames: [...(defaultSchema.tagNames ?? []), 'iframe', 'figure', 'figcaption'],
    attributes: {
        ...defaultSchema.attributes,
        span: [...(defaultSchema.attributes?.span ?? []), 'style'],
        iframe: ['src'],
    },
}

type Part =
    | { type: 'text'; text: string }
    | { type: 'embed'; embed: Embed }
    | { type: 'collapsible'; title: string; body: string }

function splitEmbeds(text: string, defs: EmbedDef[]): Part[] {
    const parts: Part[] = []
    const re = /!\[[^\]]*\]\(([^)]+)\)/g
    let lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = re.exec(text)) !== null) {
        const embed = detectEmbed(match[1], defs)
        if (!embed) continue

        if (match.index > lastIndex) {
            parts.push({ type: 'text', text: text.slice(lastIndex, match.index) })
        }
        parts.push({ type: 'embed', embed })
        lastIndex = match.index + match[0].length
    }

    if (lastIndex < text.length) {
        parts.push({ type: 'text', text: text.slice(lastIndex) })
    }

    return parts.length > 0 ? parts : [{ type: 'text', text }]
}

interface ColorFrame {
    color: string
    tokenIndex: number
    parenDepth: number
}

function colorTagAt(text: string, start: number): { color: string; end: number } | null {
    if (text[start] !== '{') return null

    let i = start + 1
    if (text[i] === '#') {
        const hexStart = ++i
        while (i - hexStart < 9 && /[0-9A-Fa-f]/.test(text[i] ?? '')) i++
        if (i - hexStart < 3 || i - hexStart > 8) return null
    } else {
        const nameStart = i
        while (/[A-Za-z]/.test(text[i] ?? '')) i++
        if (i === nameStart) return null
    }

    if (text[i] !== '}' || text[i + 1] !== '(') return null
    return { color: text.slice(start + 1, i), end: i + 2 }
}

// Modworkshop uses {#HEX}(text) or {ColorName}(text) for inline colored text.
// Parse it with a stack so nested tags and parentheses remain linear in the input size.
function parseColorTags(text: string): string {
    const output: string[] = []
    const stack: ColorFrame[] = []

    for (let i = 0; i < text.length;) {
        const tag = colorTagAt(text, i)
        if (tag) {
            const tokenIndex = output.length
            output.push(text.slice(i, tag.end))
            stack.push({
                color: tag.color,
                tokenIndex,
                parenDepth: 0,
            })
            i = tag.end
            continue
        }

        const frame = stack.at(-1)
        const char = text[i]
        if (frame && char === '(') {
            frame.parenDepth++
        } else if (frame && char === ')') {
            if (frame.parenDepth === 0) {
                stack.pop()
                output[frame.tokenIndex] = `<span style="color:${frame.color}">`
                output.push('</span>')
                i++
                continue
            }
            frame.parenDepth--
        }

        output.push(char)
        i++
    }

    return output.join('')
}

// Modworkshop uses !!! Title ... !!! as a collapsible section syntax not in standard markdown.
// Collapsibles are split at the React level so their body is still parsed as markdown.
function splitParts(text: string, defs: EmbedDef[]): Part[] {
    const result: Part[] = []
    const re = /^!!!(?: ?(.+))?\n([\s\S]*?)^!!!$/gm
    let lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = re.exec(text)) !== null) {
        if (match.index > lastIndex) {
            result.push(...splitEmbeds(text.slice(lastIndex, match.index), defs))
        }
        result.push({ type: 'collapsible', title: match[1]?.trim() ?? '', body: match[2] })
        lastIndex = match.index + match[0].length
    }

    if (lastIndex < text.length) {
        result.push(...splitEmbeds(text.slice(lastIndex), defs))
    }

    return result.length > 0 ? result : splitEmbeds(text, defs)
}

function Code({ children }: { children?: ReactNode }) {
    const inPre = useContext(InsidePreContext)
    return inPre ? (
        <code>{children}</code>
    ) : (
        <code className="font-mono text-[0.85em] bg-surface-hover px-1 py-0.5 rounded">
            {children}
        </code>
    )
}

function makeMdComponents(defs: EmbedDef[], onOpenDetail?: (modId: number) => void): Components {
    return {
        p: ({ children }) => (
            <div className="text-sm text-text-muted leading-relaxed mb-2">{children}</div>
        ),
        h1: ({ children }) => (
            <h1 className="text-sm font-semibold text-text mt-4 mb-1">{children}</h1>
        ),
        h2: ({ children }) => (
            <h2 className="text-sm font-semibold text-text mt-4 mb-1">{children}</h2>
        ),
        h3: ({ children }) => (
            <h3 className="text-sm font-semibold text-text mt-4 mb-1">{children}</h3>
        ),
        h4: ({ children }) => (
            <h4 className="text-sm font-semibold text-text mt-4 mb-1">{children}</h4>
        ),
        ul: ({ children }) => (
            <ul className="list-disc ml-5 mb-2 text-sm text-text-muted">{children}</ul>
        ),
        ol: ({ children }) => (
            <ol className="list-decimal ml-5 mb-2 text-sm text-text-muted">{children}</ol>
        ),
        li: ({ children }) => <li className="mb-0.5">{children}</li>,
        a: ({ href, children }) => {
            if (!href) return <>{children}</>
            const modId = onOpenDetail ? parseModworkshopModId(href) : null
            if (modId !== null && onOpenDetail) {
                return (
                    // eslint-disable-next-line no-restricted-syntax -- internal mod link navigation routed to onOpenDetail
                    <a
                        onClick={(e) => {
                            e.preventDefault()
                            onOpenDetail(modId)
                        }}
                        className="text-accent-bright underline cursor-pointer"
                    >
                        {children}
                    </a>
                )
            }
            if (!/^(https?|mailto):/i.test(href)) return <>{children}</>
            return (
                // eslint-disable-next-line no-restricted-syntax -- gated markdown link: scheme allowlisted above; click routed through api.openExternal (shell_open_external)
                <a
                    onClick={(e) => {
                        e.preventDefault()
                        api.openExternal(href)
                    }}
                    className="text-accent-bright underline cursor-pointer"
                >
                    {children}
                </a>
            )
        },
        // No color class here, matching em below. A hardcoded text color on the
        // element itself always beats an inherited color from an ancestor's inline
        // style, which silently defeats any colored wrapper around bold text.
        // Letting it inherit is also correct in the plain case, since the surrounding
        // text already sets the base color.
        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        code: Code,
        pre: ({ children }) => (
            <InsidePreContext.Provider value={true}>
                <pre className="bg-surface-hover rounded p-3 my-2 overflow-x-auto text-sm font-mono text-text">
                    {children}
                </pre>
            </InsidePreContext.Provider>
        ),
        img: ({ src, alt }) => {
            if (!src) return null
            return <img src={src} alt={alt} loading="lazy" className="max-w-full rounded my-2" />
        },
        hr: () => <hr className="border-t border-border my-3" />,
        blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-border pl-3 text-text-muted my-2">
                {children}
            </blockquote>
        ),
        table: ({ children }) => (
            <table className="w-full text-sm text-left border-collapse my-2">{children}</table>
        ),
        th: ({ children }) => (
            <th className="border border-border px-3 py-1.5 text-text font-semibold bg-surface-raised">
                {children}
            </th>
        ),
        td: ({ children }) => (
            <td className="border border-border px-3 py-1.5 text-text-muted">{children}</td>
        ),
        div: ({ children, className }) => <div className={className}>{children}</div>,
        span: ({ children, style, className }) => (
            <span style={style?.color ? { color: style.color } : undefined} className={className}>
                {children}
            </span>
        ),
        section: ({ children }) => <section>{children}</section>,
        figure: ({ children }) => <figure className="my-2">{children}</figure>,
        figcaption: ({ children }) => (
            <figcaption className="text-xs text-text-subtle mt-1">{children}</figcaption>
        ),
        br: () => <br />,
        iframe: ({ src }) => {
            if (!src) return null
            const embed = detectEmbed(src, defs)
            return embed ? <EmbedPlayer embed={embed} /> : null
        },
        script: () => null,
        style: () => null,
        object: () => null,
        embed: () => null,
    }
}

export function MarkdownContent({
    text,
    embeds = EMBEDS,
    onOpenDetail,
}: {
    text: string
    embeds?: EmbedDef[]
    onOpenDetail?: (modId: number) => void
}) {
    const components = useMemo(() => makeMdComponents(embeds, onOpenDetail), [embeds, onOpenDetail])
    const normalized = text.replace(/\r\n/g, '\n')
    const parts = splitParts(parseColorTags(normalized), embeds)

    return (
        <div>
            {parts.map((part, i) => {
                if (part.type === 'embed') return <EmbedPlayer key={i} embed={part.embed} />
                if (part.type === 'collapsible') {
                    return (
                        <details
                            key={i}
                            className="my-2 border border-border rounded-lg overflow-hidden"
                        >
                            <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-text bg-surface-raised hover:bg-surface-hover transition-colors select-none">
                                {part.title || t('detail.spoiler')}
                            </summary>
                            <div className="px-3">
                                <ReactMarkdown
                                    remarkPlugins={[remarkGfm, remarkBreaks]}
                                    rehypePlugins={[
                                        rehypeRaw,
                                        [rehypeSanitize, sanitizeSchema],
                                        rehypeHighlight,
                                    ]}
                                    components={components}
                                >
                                    {part.body}
                                </ReactMarkdown>
                            </div>
                        </details>
                    )
                }
                return (
                    <ReactMarkdown
                        key={i}
                        remarkPlugins={[remarkGfm, remarkBreaks]}
                        rehypePlugins={[
                            rehypeRaw,
                            [rehypeSanitize, sanitizeSchema],
                            rehypeHighlight,
                        ]}
                        components={components}
                    >
                        {part.text}
                    </ReactMarkdown>
                )
            })}
        </div>
    )
}
