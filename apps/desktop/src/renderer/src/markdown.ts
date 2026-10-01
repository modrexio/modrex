import MarkdownIt from 'markdown-it'
import type { RendererRule, StateInline } from 'markdown-it'
import colorInline from 'markdown-it-color-inline'
import taskLists from 'markdown-it-task-lists'
import { markdownContainer } from './markdownContainer'
import { contrastRatio } from './colorContrast'
import { legacyBbcodeToHtml } from './legacyBbcode'

// The sanitizer strips style.
const alignCell: RendererRule = (tokens, idx, options, _env, self) => {
    const token = tokens[idx]
    const style = token.attrGet('style')
    if (typeof style === 'string') {
        token.attrs = token.attrs!.filter(([name]) => name !== 'style')
        token.attrSet('align', style.replace('text-align:', ''))
    }
    return self.renderToken(tokens, idx, options)
}

function createMarkdown() {
    const md = new MarkdownIt({ breaks: true, linkify: true })
    md.linkify.set({ fuzzyLink: false })
    md.linkify.add('//', null)
    md.use(taskLists)
    md.renderer.rules.th_open = alignCell
    md.renderer.rules.td_open = alignCell
    return md
}

const plain = createMarkdown()

const modworkshop = createMarkdown()
modworkshop.use(colorInline)
modworkshop.use(markdownContainer, 'spoiler', '!')
modworkshop.use(markdownContainer, 'center', ':')

// ModWorkshop's threshold against its page color.
function readableColor(color: string) {
    const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1]
    return !hex || contrastRatio(hex, '2b3036') >= 2.9
}

modworkshop.renderer.rules.color_open = (tokens, idx) => {
    const color = tokens[idx].info
    if (!readableColor(color)) return '<span>'
    return `<span data-color="${modworkshop.utils.escapeHtml(color)}">`
}

modworkshop.renderer.rules.container_spoiler_open = (tokens, idx) =>
    `<details><summary>${modworkshop.utils.escapeHtml(tokens[idx].info.trim())}</summary><div>`
modworkshop.renderer.rules.container_spoiler_close = () => '</div></details>'
modworkshop.renderer.rules.container_center_open = () => '<div class="center">'
modworkshop.renderer.rules.container_center_close = () => '</div>'

const underline: RendererRule = (tokens, idx, options, _env, self) => {
    const token = tokens[idx]
    if (token.markup === '__') token.tag = 'u'
    return self.renderToken(tokens, idx, options)
}
modworkshop.renderer.rules.strong_open = underline
modworkshop.renderer.rules.strong_close = underline

function mention(state: StateInline, silent: boolean) {
    const start = state.pos
    if (silent || state.src.charCodeAt(start) !== 0x40) return false
    if (start > 0 && !/[ \t\n]/.test(state.src[start - 1])) return false

    let end = start + 1
    while (end < state.posMax && /[A-Za-z0-9_-]/.test(state.src[end])) end++
    if (end === start + 1) return false

    const name = state.src.slice(start + 1, end)
    state.push('link_open', 'a', 1).attrs = [['href', `https://modworkshop.net/user/${name}`]]
    state.push('text', '', 0).content = `@${name}`
    state.push('link_close', 'a', -1)
    state.pos = end
    return true
}
modworkshop.inline.ruler.after('emphasis', 'mention', mention)

// html is safe here only because author text is escaped before legacyBbcodeToHtml.
const legacy = createMarkdown()
legacy.set({ html: true })
legacy.linkify.set({ fuzzyLink: true })
legacy.renderer.rules.strong_open = underline
legacy.renderer.rules.strong_close = underline
legacy.inline.ruler.after('emphasis', 'mention', mention)

const LEGACY_CENTER = /^ {0,3}(:::+) *([\s\S]*?)\n? {0,3}\1/

function legacyCenter(state: StateInline, silent: boolean) {
    const match = LEGACY_CENTER.exec(state.src.slice(state.pos, state.posMax))
    if (!match) return false
    if (!silent) {
        state.push('html_inline', '', 0).content =
            `<span class="center">${legacy.renderInline(match[2])}</span>`
    }
    state.pos += match[0].length
    return true
}
legacy.inline.ruler.push('legacy_center', legacyCenter)

const LEGACY_SPOILER = /(?:^|\n) {0,3}(\|\|+) *([\s\S]*?)\n? {0,3}\1/g

function renderLegacy(text: string) {
    const html = legacyBbcodeToHtml(legacy.utils.escapeHtml(text))
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replace(
            LEGACY_SPOILER,
            (_match: string, _run: string, body: string) =>
                `\n\n<details><summary></summary><div>${legacy.render(body)}</div></details>\n\n`
        )
    return legacy.render(html)
}

export function renderMarkdown(text: string): string {
    return plain.render(text)
}

export function renderModworkshopMarkdown(text: string, legacyMarkup: boolean): string {
    return legacyMarkup ? renderLegacy(text) : modworkshop.render(text)
}
