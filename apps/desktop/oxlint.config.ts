import { defineConfig } from 'oxlint'

// Hardcoded Tailwind color utilities (e.g. bg-red-500). The project uses only the semantic
// tokens defined in index.css's @theme block (surface, accent, danger and so on). Matches a
// known utility prefix plus color family plus shade, scoped to className attributes below so
// prose and other strings can never false-positive.
const tailwindColor =
    '(bg|text|border|ring|from|to|via|fill|stroke|outline|divide|placeholder|shadow|accent|caret|decoration)-' +
    '(zinc|slate|gray|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-' +
    '(50|100|200|300|400|500|600|700|800|900|950)'

// The rules below match eslint:recommended, typescript-eslint's recommended set and the
// renderer's react-hooks recommended set. Oxlint's
// correctness category stays on as well. Its parser already rejects legacy octal literals, which
// covers no-octal.
export default defineConfig({
    plugins: ['eslint', 'typescript'],
    categories: { correctness: 'error' },
    rules: {
        'eslint/no-case-declarations': 'error',
        'eslint/no-empty': 'error',
        'eslint/no-fallthrough': 'error',
        'eslint/no-prototype-builtins': 'error',
        'eslint/no-regex-spaces': 'error',
        'eslint/no-unexpected-multiline': 'error',
        'eslint/no-useless-assignment': 'error',
        'eslint/no-var': 'error',
        'eslint/prefer-const': 'error',
        'eslint/prefer-rest-params': 'error',
        'eslint/prefer-spread': 'error',
        'eslint/preserve-caught-error': 'error',
        'typescript/ban-ts-comment': 'error',
        'typescript/no-array-constructor': 'error',
        'typescript/no-empty-object-type': 'error',
        'typescript/no-explicit-any': 'error',
        'typescript/no-namespace': 'error',
        'typescript/no-require-imports': 'error',
        'typescript/no-unnecessary-type-constraint': 'error',
        'typescript/no-unsafe-function-type': 'error',
        'typescript/no-unused-expressions': 'error',
        // An options object turns off oxlint's default exemption for underscore names, which
        // ESLint never had.
        'typescript/no-unused-vars': ['error', {}],
    },
    overrides: [
        {
            files: ['scripts/**/*.mts', 'src/shared/i18n-values.mts'],
            env: { node: true },
        },
        {
            // The CLI tests assert the exact ANSI escapes the terminal output carries.
            files: ['scripts/**/*.test.mts'],
            rules: { 'eslint/no-control-regex': 'off' },
        },
        {
            files: ['src/renderer/{src,preview}/**/*.{ts,tsx}'],
            plugins: ['eslint', 'typescript', 'react'],
            // Oxlint has no native no-restricted-syntax, so ESLint's own rule runs as a JS
            // plugin. Disable comments must name it eslint-js/no-restricted-syntax.
            jsPlugins: [{ name: 'eslint-js', specifier: 'oxlint-plugin-eslint' }],
            env: { browser: true },
            rules: {
                'react/rules-of-hooks': 'error',
                'react/exhaustive-deps': 'warn',
                'react/error-boundaries': 'error',
                'react/globals': 'error',
                'react/immutability': 'error',
                'react/preserve-manual-memoization': 'error',
                'react/purity': 'error',
                'react/refs': 'error',
                'react/set-state-in-render': 'error',
                'react/static-components': 'error',
                'react/use-memo': 'error',
                'react/incompatible-library': 'warn',
                'react/unsupported-syntax': 'warn',
                'react/set-state-in-effect': 'off',
                // Codified project invariants (see AGENTS.md). The codebase is clean against
                // all of these today; these rules keep it that way.
                'eslint-js/no-restricted-syntax': [
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
        },
    ],
})
