import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

// Hardcoded Tailwind color utilities (e.g. bg-red-500). The project uses only the semantic
// tokens defined in index.css's @theme block (surface, accent, danger and so on). Matches a
// known utility prefix plus color family plus shade, scoped to className attributes below so
// prose and other strings can never false-positive.
const tailwindColor =
    '(bg|text|border|ring|from|to|via|fill|stroke|outline|divide|placeholder|shadow|accent|caret|decoration)-' +
    '(zinc|slate|gray|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-' +
    '(50|100|200|300|400|500|600|700|800|900|950)'

export default tseslint.config(
    { ignores: ['node_modules/**', 'out/**', 'src-tauri/**', 'src/shared/bindings.ts'] },
    {
        files: ['src/renderer/{src,preview}/**/*.{ts,tsx}'],
        extends: [js.configs.recommended, ...tseslint.configs.recommended],
        plugins: { 'react-hooks': reactHooks },
        rules: {
            ...reactHooks.configs.recommended.rules,
            'react-hooks/set-state-in-effect': 'off',
            // Codified project invariants (see CLAUDE.md). The codebase is clean against
            // all of these today; these rules keep it that way.
            'no-restricted-syntax': [
                'error',
                {
                    selector:
                        "CallExpression[callee.object.name='window'][callee.property.name=/^(alert|confirm|prompt)$/], CallExpression[callee.name=/^(alert|confirm|prompt)$/]",
                    message:
                        'Use the Dialog component (components/Dialog.tsx), never window.confirm/alert/prompt.',
                },
                {
                    selector: "JSXOpeningElement[name.name='a']",
                    message:
                        'Open links via api.openExternal (gated through shell_open_external), not a raw <a> element.',
                },
                {
                    selector: `JSXAttribute[name.name='className'] Literal[value=/${tailwindColor}/]`,
                    message:
                        'Use a semantic color token from index.css (@theme), not a hardcoded Tailwind color class.',
                },
                {
                    selector: `JSXAttribute[name.name='className'] TemplateElement[value.cooked=/${tailwindColor}/]`,
                    message:
                        'Use a semantic color token from index.css (@theme), not a hardcoded Tailwind color class.',
                },
                {
                    selector:
                        "Program > VariableDeclaration > VariableDeclarator > ObjectExpression CallExpression[callee.name='t']",
                    message:
                        't() calls in a module-scope object literal are evaluated once at import and never react to a locale switch — call t() inside a component (e.g. via useMemo) instead.',
                },
                {
                    selector:
                        "Program > VariableDeclaration > VariableDeclarator > ArrayExpression CallExpression[callee.name='t']",
                    message:
                        't() calls in a module-scope array literal are evaluated once at import and never react to a locale switch — call t() inside a component (e.g. via useMemo) instead.',
                },
            ],
        },
        languageOptions: {
            globals: globals.browser,
        },
    }
)
