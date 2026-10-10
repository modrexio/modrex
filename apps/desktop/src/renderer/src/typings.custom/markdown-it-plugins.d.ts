declare module 'markdown-it-color-inline' {
    import type { MarkdownIt } from 'markdown-it'
    const plugin: (md: MarkdownIt) => void
    export default plugin
}

declare module 'markdown-it-task-lists' {
    import type { MarkdownIt } from 'markdown-it'
    const plugin: (md: MarkdownIt) => void
    export default plugin
}
