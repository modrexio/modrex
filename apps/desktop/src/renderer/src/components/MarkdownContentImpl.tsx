import { useMemo, createContext, useContext, type ReactNode } from 'react'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import { unified } from 'unified'
import rehypeParse from 'rehype-parse'
import rehypeSanitize, { defaultSchema, type Options as SanitizeOptions } from 'rehype-sanitize'
import rehypeHighlight from 'rehype-highlight'
import { toJsxRuntime, type Components } from 'hast-util-to-jsx-runtime'
import { t } from '../i18n'
import { detectEmbed } from '../embeds'
import { renderMarkdown, renderModworkshopMarkdown } from '../markdown'
import 'highlight.js/styles/github-dark.css'
import { api } from '../api'
import { parseModworkshopModId } from '../modLinks'
import { EmbedPlayer } from './EmbedPlayer'

const InsidePreContext = createContext(false)

// Defense in depth: markdown-it already escapes raw HTML, so this only ever sees markup
// the parser and its plugins wrote. Must run before rehypeHighlight so its hljs classes
// survive. span keeps data-color, which the span component turns into a color, and div
// keeps the class of a ::: block.
const sanitizeSchema: SanitizeOptions = {
    ...defaultSchema,
    tagNames: [...(defaultSchema.tagNames ?? []), 'u'],
    attributes: {
        ...defaultSchema.attributes,
        span: [...(defaultSchema.attributes?.span ?? []), 'dataColor'],
        div: [...(defaultSchema.attributes?.div ?? []), ['className', 'center']],
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

function makeComponents(onOpenDetail?: (modId: number) => void): Components {
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
        ol: ({ children, start }) => (
            <ol start={start} className="list-decimal ml-5 mb-2 text-sm text-text-muted">
                {children}
            </ol>
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
        // ModWorkshop embeds a video by writing it as an image.
        img: ({ src, alt }) => {
            if (typeof src !== 'string' || !src) return null
            const embed = detectEmbed(src)
            if (embed) return <EmbedPlayer embed={embed} />
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
        // style here is only the text-align that toJsxRuntime makes from the align attribute.
        th: ({ children, style }) => (
            <th
                style={style}
                className="border border-border px-3 py-1.5 text-text font-semibold bg-surface-raised"
            >
                {children}
            </th>
        ),
        td: ({ children, style }) => (
            <td style={style} className="border border-border px-3 py-1.5 text-text-muted">
                {children}
            </td>
        ),
        span: ({ children, className, node }) => {
            const color = node?.properties.dataColor
            return (
                <span
                    style={typeof color === 'string' ? { color } : undefined}
                    className={className}
                >
                    {children}
                </span>
            )
        },
        div: ({ children, className }) => (
            <div className={className === 'center' ? 'text-center [&_div]:mx-auto' : undefined}>
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
    onOpenDetail,
}: {
    text: string
    onOpenDetail?: (modId: number) => void
}) {
    const html = useMemo(() => renderModworkshopMarkdown(text), [text])
    return <Markup html={html} onOpenDetail={onOpenDetail} />
}
