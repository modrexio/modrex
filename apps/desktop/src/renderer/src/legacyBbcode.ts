import { contrastRatio } from './colorContrast'

// ModWorkshop's legacy parser turns BBCode into HTML before markdown runs, and text comes
// in already HTML-escaped. [*] and [hr] stand alone, other tags need a closing tag of the
// same name, and anything left unpaired stays as written. Tags that cross, like
// [b][i]x[/b][/i], close the way a browser repairs the same HTML, which is what
// ModWorkshop's own output ends up as. Line breaks inside a tag become br, a line break
// right after an opening tag is dropped, and [code], [img], [video] and [noparse] take
// their content verbatim.

interface Tag {
    name: string
    closing: boolean
    attr: string
    start: number
    end: number
    pair: number | null
}

const TAG = /\[(\/)?(\w+|\*+)(?:[ =](.*?))?\](\r\n|\r|\n)?/g

const KNOWN = new Set([
    'b',
    'i',
    'u',
    's',
    'list',
    '*',
    'hr',
    'url',
    'email',
    'quote',
    'spoiler',
    'center',
    'left',
    'right',
    'align',
    'code',
    'color',
    'size',
    'font',
    'img',
    'video',
    'noparse',
])
const UNPAIRED = new Set(['*', 'hr'])
const VERBATIM = new Set(['code', 'img', 'video', 'noparse'])

const SIMPLE: Record<string, string> = { b: 'strong', i: 'em', u: 'u', s: 'del', list: 'ul' }

const SIZES: Record<string, string> = {
    'xx-small': 'small',
    'x-small': 'small',
    small: 'small',
    large: 'large',
    'x-large': 'x-large',
    'xx-large': 'x-large',
}

const VIDEO_PAGES: Record<string, (id: string) => string> = {
    youtube: (id) => `https://www.youtube.com/watch?v=${id}`,
    streamable: (id) => `https://streamable.com/${id}`,
    vimeo: (id) => `https://vimeo.com/${id}`,
}

// Values are escaped already. The caller turns &quot; back into a quote afterwards, so a
// quote inside an attribute is kept in a form that survives that.
function attr(value: string) {
    return value.replaceAll('&quot;', '&#34;')
}

function tokenize(text: string): Tag[] {
    const tags: Tag[] = []
    for (const m of text.matchAll(TAG)) {
        const name = m[2].toLowerCase()
        if (!KNOWN.has(name)) continue
        const closing = m[1] === '/'
        const newline = closing && m[4] ? m[4].length : 0
        tags.push({
            name,
            closing,
            attr: (m[3] ?? '').trim().replace(/^&quot;|&quot;$/g, ''),
            start: m.index,
            end: m.index + m[0].length - newline,
            pair: null,
        })
    }
    const open: Record<string, number[]> = {}
    tags.forEach((tag, i) => {
        if (UNPAIRED.has(tag.name)) return
        const stack = (open[tag.name] ??= [])
        if (!tag.closing) {
            stack.push(i)
            return
        }
        const start = stack.pop()
        if (start === undefined) return
        tag.pair = start
        tags[start].pair = i
    })
    return tags
}

function colorSpan(value: string, inner: string) {
    if (/^#?[0-9a-f]{6}$/i.test(value)) {
        const hex = value.replace('#', '')
        // The legacy parser keeps a hex color only above 3.2 contrast against #1a1c1e.
        if (contrastRatio(hex, '1a1c1e') <= 3.2) return inner
        return `<span data-color="#${hex}">${inner}</span>`
    }
    if (/^[a-z]+$/i.test(value)) return `<span data-color="${value}">${inner}</span>`
    return inner
}

function videoImage(host: string, raw: string) {
    const page = VIDEO_PAGES[host.toLowerCase()]
    const value = raw.trim()
    if (!page || !value) return ''
    let src = page(value)
    if (/^https?:\/\//i.test(value)) src = value
    else if (value.includes('.')) src = `https://${value}`
    return `<img src="${attr(src)}">`
}

function renderTag(tag: Tag, inner: string, raw: string) {
    const simple = SIMPLE[tag.name]
    if (simple) return `<${simple}>${inner}</${simple}>`
    switch (tag.name) {
        case 'url':
            return `<a href="${attr(tag.attr || raw.trim())}">${inner}</a>`
        case 'quote':
            return `<blockquote>${inner}</blockquote>`
        case 'spoiler':
            return `<details><summary></summary><div>${inner}</div></details>`
        case 'center':
        case 'left':
        case 'right':
            return `<div class="${tag.name}">${inner}</div>`
        case 'align': {
            const side = tag.attr === 'center' || tag.attr === 'right' ? tag.attr : 'left'
            return `<div class="${side}">${inner}</div>`
        }
        case 'code':
            return `<pre><code>${raw.replaceAll('&nbsp;', ' ')}</code></pre>`
        case 'color':
            return inner ? colorSpan(tag.attr, inner) : ''
        case 'size': {
            // Even an unknown size keeps its span, which decides how markdown reads the
            // lines around it.
            const size = SIZES[tag.attr.toLowerCase()]
            return `<span${size ? ` data-size="${size}"` : ''}>${inner}</span>`
        }
        case 'img':
            return raw.trim() ? `<img src="${attr(raw.trim())}" alt="${attr(tag.attr)}">` : ''
        case 'video':
            return videoImage(tag.attr, raw)
        default:
            // font, email and noparse keep their content and drop the tag.
            return inner
    }
}

function textPart(text: string, inTag: boolean) {
    return inTag ? text.replace(/\r?\n+|\r/g, '<br>') : text
}

function renderRange(
    text: string,
    tags: Tag[],
    from: number,
    to: number,
    start: number,
    end: number,
    inTag: boolean
): string {
    let out = ''
    let cursor = start
    for (let i = from; i < to; i++) {
        const tag = tags[i]
        out += textPart(text.slice(cursor, tag.start), inTag)
        cursor = tag.end
        if (!tag.closing && UNPAIRED.has(tag.name)) {
            out += tag.name === 'hr' ? '<hr>' : '<li>'
            continue
        }
        if (tag.pair === null) {
            out += textPart(text.slice(tag.start, tag.end), inTag)
            continue
        }
        // Reached only when its opening tag crossed out of an enclosing tag and was
        // already closed at that tag's end.
        if (tag.closing) continue

        const crosses = tag.pair >= to
        const innerEnd = crosses ? end : tags[tag.pair].start
        const raw = text.slice(tag.end, innerEnd)
        const inner = VERBATIM.has(tag.name)
            ? raw
            : renderRange(text, tags, i + 1, crosses ? to : tag.pair, tag.end, innerEnd, true)
        out += renderTag(tag, inner, raw)
        if (crosses) return out
        cursor = tags[tag.pair].end
        i = tag.pair
    }
    return out + textPart(text.slice(cursor, end), inTag)
}

export function legacyBbcodeToHtml(escaped: string): string {
    const tags = tokenize(escaped)
    return renderRange(escaped, tags, 0, tags.length, 0, escaped.length, false)
}
