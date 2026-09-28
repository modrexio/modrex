import type MarkdownIt from 'markdown-it'
import type { StateBlock } from 'markdown-it'

// A closing run must be at least as long as the opening one. Unclosed runs to the end.
export function markdownContainer(md: MarkdownIt, name: string, marker: string) {
    const code = marker.charCodeAt(0)

    function rule(state: StateBlock, startLine: number, endLine: number, silent: boolean) {
        const start = state.bMarks[startLine] + state.tShift[startLine]
        const max = state.eMarks[startLine]
        if (state.src.charCodeAt(start) !== code) return false

        let pos = start
        while (pos < max && state.src.charCodeAt(pos) === code) pos++
        const count = pos - start
        if (count < 3) return false
        if (silent) return true

        const run = marker.repeat(count)
        const rest = state.src.slice(pos, max)
        const inlineEnd = state.tShift[startLine] === 0 ? rest.indexOf(run) : -1
        if (inlineEnd !== -1) {
            state.push(`container_${name}_open`, 'div', 1).markup = run
            const inline = state.push('inline', '', 0)
            inline.content = rest.slice(0, inlineEnd).trim()
            inline.children = []
            state.push(`container_${name}_close`, 'div', -1).markup = run

            const trailing = rest.slice(inlineEnd + count).trim()
            if (trailing) {
                const after = state.push('inline', '', 0)
                after.content = trailing
                after.children = []
            }
            state.line = startLine + 1
            return true
        }

        let nextLine = startLine
        let closed = false
        while (++nextLine < endLine) {
            const lineStart = state.bMarks[nextLine] + state.tShift[nextLine]
            const lineMax = state.eMarks[nextLine]
            if (lineStart < lineMax && state.sCount[nextLine] < state.blkIndent) break
            if (state.src.charCodeAt(lineStart) !== code) continue
            if (state.sCount[nextLine] - state.blkIndent >= 4) continue

            let p = lineStart
            while (p < lineMax && state.src.charCodeAt(p) === code) p++
            if (p - lineStart < count) continue
            if (state.skipSpaces(p) < lineMax) continue

            closed = true
            break
        }

        const oldLineMax = state.lineMax
        state.lineMax = nextLine

        const open = state.push(`container_${name}_open`, 'div', 1)
        open.markup = run
        open.info = rest
        open.map = [startLine, nextLine]
        state.md.block.tokenize(state, startLine + 1, nextLine)
        state.push(`container_${name}_close`, 'div', -1).markup = run

        state.lineMax = oldLineMax
        state.line = nextLine + (closed ? 1 : 0)
        return true
    }

    md.block.ruler.before('fence', `container_${name}`, rule, {
        alt: ['paragraph', 'reference', 'blockquote', 'list'],
    })
}
