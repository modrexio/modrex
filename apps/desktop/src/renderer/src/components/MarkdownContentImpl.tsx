import { useMemo, createContext, useContext, type ReactNode } from 'react'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import { unified } from 'unified'
import rehypeParse from 'rehype-parse'
import rehypeSanitize, { defaultSchema, type Options as SanitizeOptions } from 'rehype-sanitize'
import rehypeHighlight from 'rehype-highlight'
import { toJsxRuntime, type Components } from 'hast-util-to-jsx-runtime'
import { t } from '../i18n'
import { detectEmbed, mediaKind } from '../embeds'
import { renderMarkdown, renderModworkshopMarkdown } from '../markdown'
import 'highlight.js/styles/github-dark.css'
import { api } from '../api'
import { parseModworkshopModId } from '../modLinks'
import { EmbedPlayer } from './EmbedPlayer'
import { ScrollArea } from './ScrollArea'

const InsidePreContext = createContext(false)

// Must run before rehypeHighlight so its hljs classes survive.
const sanitizeSchema: SanitizeOptions = {
    ...defaultSchema,
    tagNames: [...(defaultSchema.tagNames ?? []), 'u'],
    attributes: {
        ...defaultSchema.attributes,
        span: [
            ...(defaultSchema.attributes?.span ?? []),
            'dataColor',
            'dataSize',
            ['className', 'center'],
        ],
        div: [...(defaultSchema.attributes?.div ?? []), ['className', 'center', 'left', 'right']],
    },
}

const processor = unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeSanitize, sanitizeSchema)
    .use(rehypeHighlight)

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

const ALIGN: Record<string, string> = {
    center: 'text-center [&_div]:mx-auto',
    left: 'text-left',
    right: 'text-right',
}

function makeComponents(onOpenDetail?: (modId: number) => void): Components {
    return {
        p: ({ children }) => (
            <div className="text-sm text-text leading-relaxed mb-2">{children}</div>
        ),
        h1: ({ children }) => (
            <h1 className="text-[1.75rem] font-semibold text-text mt-4 mb-3 pb-2 border-b border-border">
                {children}
            </h1>
        ),
        h2: ({ children }) => (
            <h2 className="text-[1.3125rem] font-semibold text-text mt-4 mb-3 pb-2 border-b border-border">
                {children}
            </h2>
        ),
        h3: ({ children }) => (
            <h3 className="text-base font-semibold text-text mt-4 mb-2">{children}</h3>
        ),
        h4: ({ children }) => (
            <h4 className="text-sm font-semibold text-text mt-4 mb-2">{children}</h4>
        ),
        ul: ({ children }) => <ul className="list-disc ml-5 mb-2 text-sm text-text">{children}</ul>,
        ol: ({ children, start }) => (
            <ol start={start} className="list-decimal ml-5 mb-2 text-sm text-text">
                {children}
            </ol>
        ),
        li: ({ children }) => <li className="mb-2">{children}</li>,
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
        strong: ({ children }) => <strong className="font-bold">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        code: Code,
        pre: ({ children }) => (
            <InsidePreContext.Provider value={true}>
                <ScrollArea
                    hostClassName="my-2 rounded bg-surface-hover"
                    className="overflow-x-auto"
                >
                    <pre className="p-3 text-sm font-mono text-text">{children}</pre>
                </ScrollArea>
            </InsidePreContext.Provider>
        ),
        img: ({ src, alt }) => {
            if (typeof src !== 'string' || !src) return null
            const embed = detectEmbed(src)
            if (embed) return <EmbedPlayer embed={embed} />
            const media = mediaKind(src)
            if (media === 'video') {
                return (
                    <video src={src} controls preload="metadata" className="max-w-xl w-full my-2" />
                )
            }
            if (media === 'audio') {
                return (
                    <audio src={src} controls preload="metadata" className="max-w-xl w-full my-2" />
                )
            }
            return (
                <img
                    src={src}
                    alt={alt}
                    loading="lazy"
                    className="max-w-full max-h-[250px] rounded my-2"
                />
            )
        },
        hr: () => <hr className="border-t border-border my-3" />,
        blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-border pl-3 text-text-muted my-2">
                {children}
            </blockquote>
        ),
        table: ({ children }) => (
            <ScrollArea hostClassName="my-2" className="overflow-x-auto">
                <table className="block max-w-full text-sm text-left border-collapse">
                    {children}
                </table>
            </ScrollArea>
        ),
        th: ({ children, style }) => (
            <th
                style={style}
                className="border border-border px-3 py-1.5 text-text font-semibold bg-surface-raised"
            >
                {children}
            </th>
        ),
        td: ({ children, style }) => (
            <td style={style} className="border border-border px-3 py-1.5 text-text">
                {children}
            </td>
        ),
        span: ({ children, className, node }) => {
            const dataColor = node?.properties.dataColor
            const dataSize = node?.properties.dataSize
            return (
                <span
                    style={{
                        color: typeof dataColor === 'string' ? dataColor : undefined,
                        fontSize: typeof dataSize === 'string' ? dataSize : undefined,
                    }}
                    className={className === 'center' ? 'block text-center' : className}
                >
                    {children}
                </span>
            )
        },
        div: ({ children, className }) => (
            <div className={typeof className === 'string' ? ALIGN[className] : undefined}>
                {children}
            </div>
        ),
        details: ({ children }) => (
            <details className="my-2 border border-border rounded-lg overflow-hidden [&>div]:px-3">
                {children}
            </details>
        ),
        summary: ({ children }) => (
            <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-text bg-surface-raised hover:bg-surface-hover transition-colors select-none">
                {children ?? t('detail.spoiler')}
            </summary>
        ),
    }
}

function Markup({ html, onOpenDetail }: { html: string; onOpenDetail?: (modId: number) => void }) {
    const components = useMemo(() => makeComponents(onOpenDetail), [onOpenDetail])
    const content = useMemo(() => {
        const tree = processor.runSync(processor.parse(html))
        return toJsxRuntime(tree, { Fragment, jsx, jsxs, components, passNode: true })
    }, [html, components])
    return <div>{content}</div>
}

export function MarkdownContent({ text }: { text: string }) {
    const html = useMemo(() => renderMarkdown(text), [text])
    return <Markup html={html} />
}

export function ModworkshopMarkup({
    text,
    legacy = false,
    onOpenDetail,
}: {
    text: string
    legacy?: boolean
    onOpenDetail?: (modId: number) => void
}) {
    const html = useMemo(() => renderModworkshopMarkdown(text, legacy), [text, legacy])
    return <Markup html={html} onOpenDetail={onOpenDetail} />
}
