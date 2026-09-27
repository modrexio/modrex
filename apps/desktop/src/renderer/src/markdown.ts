import MarkdownIt from 'markdown-it'
import type { RendererRule } from 'markdown-it'
import colorInline from 'markdown-it-color-inline'
import taskLists from 'markdown-it-task-lists'
import { markdownContainer } from './markdownContainer'

// The parser and options ModWorkshop renders mod text with, so a description lays out the
// way its author saw it on the site. Raw HTML stays off, as it is there.
const md = new MarkdownIt({ breaks: true, linkify: true })
md.linkify.set({ fuzzyLink: false })
md.linkify.add('//', null)
md.use(colorInline)
md.use(taskLists)
md.use(markdownContainer, 'spoiler', '!')

// {color}(text). The span component turns data-color into a style, so no author text
// ever reaches a style attribute directly.
md.renderer.rules.color_open = (tokens, idx) =>
    `<span data-color="${md.utils.escapeHtml(tokens[idx].info)}">`

md.renderer.rules.container_spoiler_open = (tokens, idx) =>
    `<details><summary>${md.utils.escapeHtml(tokens[idx].info.trim())}</summary><div>`
md.renderer.rules.container_spoiler_close = () => '</div></details>'

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
md.renderer.rules.th_open = alignCell
md.renderer.rules.td_open = alignCell

export function renderMarkdown(text: string): string {
    return md.render(text)
}
