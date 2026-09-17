import { defineConfig, normalizePath } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import svgr from 'vite-plugin-svgr'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import pkg from './package.json' with { type: 'json' }

const startupIconPath = fileURLToPath(new URL('./assets/icon.png', import.meta.url)).replaceAll(
    '\\',
    '/'
)

const previewDir = normalizePath(resolve(import.meta.dirname, 'src/renderer/preview'))
const bindingsPath = normalizePath(resolve(import.meta.dirname, 'src/shared/bindings.ts'))

const previewShims: Record<string, string> = {
    '@tauri-apps/api/core': 'tauri/core.ts',
    '@tauri-apps/api/event': 'tauri/event.ts',
    '@tauri-apps/api/window': 'tauri/window.ts',
    '@tauri-apps/api/webview': 'tauri/webview.ts',
    '@tauri-apps/plugin-log': 'tauri/log.ts',
}

// The preview's own files keep the real bindings, since the mock command table wraps them.
function previewBackend(): Plugin {
    return {
        name: 'preview-backend',
        enforce: 'pre',
        transformIndexHtml: {
            order: 'pre',
            handler(html, context) {
                if (!context.filename.endsWith('index.html')) return html
                return html.replace(
                    '<script type="module"',
                    '<script type="module" src="/preview/boot.ts"></script>\n        <script type="module"'
                )
            },
        },
        async resolveId(source, importer, options) {
            const shim = previewShims[source]
            if (shim) return normalizePath(resolve(previewDir, shim))
            if (importer && normalizePath(importer).startsWith(previewDir)) return null
            const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
            if (resolved && normalizePath(resolved.id) === bindingsPath) {
                return normalizePath(resolve(previewDir, 'bindings.ts'))
            }
            return resolved
        },
    }
}

export default defineConfig(({ mode }) => ({
    root: 'src/renderer',
    clearScreen: false,
    server: {
        port: 5173,
        strictPort: true,
    },
    envPrefix: ['VITE_', 'TAURI_ENV_*'],
    define: {
        'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
    },
    plugins: [
        ...(mode === 'preview' ? [previewBackend()] : []),
        {
            name: 'startup-icon-dev-path',
            transformIndexHtml: {
                order: 'pre',
                handler(html, context) {
                    if (!context.server) return html
                    return html.replace('../../assets/icon.png', `/@fs/${startupIconPath}`)
                },
            },
        },
        svgr(),
        react(),
        tailwindcss(),
    ],
    build: {
        outDir: mode === 'preview' ? '../../out/preview' : '../../out/renderer',
        emptyOutDir: true,
        target: 'chrome105',
        minify: true,
        sourcemap: false,
        rolldownOptions: {
            input: {
                main: resolve(import.meta.dirname, 'src/renderer/index.html'),
                splash: resolve(import.meta.dirname, 'src/renderer/splash.html'),
            },
        },
    },
}))
