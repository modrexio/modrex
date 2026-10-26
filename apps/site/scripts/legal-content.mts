import { parse } from '@astrojs/compiler-rs'

type Expression =
    | { type: 'Literal'; value: string | number }
    | { type: 'Identifier'; name: string }
    | { type: 'CallExpression'; callee: Expression; arguments: Expression[] }
    | { type: 'JSXEmptyExpression' }

type Element = {
    type: 'JSXElement'
    openingElement: {
        name: { name: string }
        attributes: { name: { name: string }; value: Expression | Container }[]
    }
    children: Node[]
}
type Container = { type: 'JSXExpressionContainer'; expression: Expression }
type Node =
    | Element
    | Container
    | { type: 'JSXText'; value: string }
    | { type: 'AstroComment'; value: string }

function findMain(nodes: Node[]): Element | undefined {
    for (const node of nodes) {
        if (node.type !== 'JSXElement') continue
        if (node.openingElement.name.name === 'main') return node
        const main = findMain(node.children)
        if (main) return main
    }
}

function linkTarget(node: Expression | Container): string {
    if (node.type === 'Literal') return String(node.value)
    if (node.type === 'JSXExpressionContainer') return linkTarget(node.expression)
    if (
        node.type === 'CallExpression' &&
        node.callee.type === 'Identifier' &&
        node.callee.name === 'sitePath' &&
        node.arguments.length === 1 &&
        node.arguments[0]!.type === 'Literal'
    ) {
        return String(node.arguments[0]!.value)
    }
    throw new Error('Legal page links must use a literal URL or sitePath with a literal URL')
}

export function legalContent(source: string): string {
    const parsed = parse(source)
    const errors = parsed.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
    if (errors.length > 0) throw new Error(errors.map((error) => error.text).join('\n'))
    const main = findMain((parsed.ast as { body: Node[] }).body)
    if (!main) throw new Error('Legal page has no main element')
    const links: string[] = []

    function text(node: Node): string {
        if (node.type === 'JSXText') return node.value
        if (node.type === 'AstroComment') return ''
        if (node.type === 'JSXExpressionContainer') {
            const expression = node.expression
            if (expression.type === 'Literal') return String(expression.value)
            if (expression.type === 'JSXEmptyExpression') return ''
            if (
                expression.type === 'CallExpression' &&
                expression.callee.type === 'Identifier' &&
                expression.callee.name === 'formatLastUpdated' &&
                expression.arguments.length === 1 &&
                expression.arguments[0]!.type === 'Identifier' &&
                expression.arguments[0]!.name === 'LAST_UPDATED'
            ) {
                return ''
            }
            throw new Error('Legal page wording must be static text')
        }
        const name = node.openingElement.name.name
        if (!/^[a-z][\w-]*$/.test(name)) throw new Error('Legal page wording must use static HTML')
        const href = node.openingElement.attributes.find(
            (attribute) => attribute.name.name === 'href'
        )
        if (href) links.push(linkTarget(href.value))
        const content = node.children.map(text).join('')
        return /^(main|div|p|h[1-6]|li|ul|ol|br)$/.test(name) ? `${content} ` : content
    }

    const wording = text(main).replace(/\s+/g, ' ').trim()
    return JSON.stringify({ wording, links })
}
