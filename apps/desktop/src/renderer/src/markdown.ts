import MarkdownIt from 'markdown-it'
import type { RendererRule } from 'markdown-it'
import colorInline from 'markdown-it-color-inline'
import taskLists from 'markdown-it-task-lists'
import { markdownContainer } from './markdownContainer'

// Column alignment comes out as a style attribute, which the sanitizer strips.
const alignCell: RendererRule = (tokens, idx, options, _env, self) => {
    const token = tokens[idx]
    const style = token.attrGet('style')
    if (style) {
        token.attrs = token.attrs!.filter(([name]) => name !== 'style')
        token.attrSet('align', style.replace('text-align:', ''))
    }
    return self.renderToken(tokens, idx, options)
}

// The parser and options ModWorkshop renders mod text with, so a description lays out the
// way its author saw it on the site. Raw HTML stays off, as it is there.
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

// {color}(text). The span component turns data-color into a style, so no author text
// ever reaches a style attribute directly.
modworkshop.renderer.rules.color_open = (tokens, idx) =>
    `<span data-color="${modworkshop.utils.escapeHtml(tokens[idx].info)}">`

modworkshop.renderer.rules.container_spoiler_open = (tokens, idx) =>
    `<details><summary>${modworkshop.utils.escapeHtml(tokens[idx].info.trim())}</summary><div>`
modworkshop.renderer.rules.container_spoiler_close = () => '</div></details>'
modworkshop.renderer.rules.container_center_open = () => '<div class="center">'
modworkshop.renderer.rules.container_center_close = () => '</div>'

// ModWorkshop reads __text__ as underline, not bold.
const underline: RendererRule = (tokens, idx, options, _env, self) => {
    const token = tokens[idx]
    if (token.markup === '__') token.tag = 'u'
    return self.renderToken(tokens, idx, options)
}
modworkshop.renderer.rules.strong_open = underline
modworkshop.renderer.rules.strong_close = underline

// Release notes and other text that isn't ModWorkshop's.
export function renderMarkdown(text: string): string {
    return plain.render(text)
}

export function renderModworkshopMarkdown(text: string): string {
    return modworkshop.render(text)
}
