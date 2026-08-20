import { defineConfig } from 'astro/config'

// Syntax theme built from the Modrex color tokens (tokens/colors.css): commands
// and keywords in accent-bright orange, operators muted, everything else the
// primary off-white. Shiki themes cannot reference CSS variables, so the hex values are
// duplicated here.
const modrexCodeTheme = {
    name: 'modrex',
    type: 'dark',
    colors: {
        'editor.background': '#1e1b1a', // --color-surface-raised
        'editor.foreground': '#f4f4f3', // --color-text
    },
    tokenColors: [
        { scope: ['comment'], settings: { foreground: '#756f6b' } }, // --color-text-subtle
        {
            scope: [
                'keyword',
                'storage',
                'entity.name.function',
                'entity.name.command',
                'support.function',
                'entity.name.tag',
            ],
            settings: { foreground: '#f87d36' }, // --color-accent-bright
        },
        {
            scope: ['keyword.operator', 'punctuation'],
            settings: { foreground: '#928c87' }, // --color-text-muted
        },
        {
            scope: ['string', 'variable', 'constant', 'entity.name.type', 'support'],
            settings: { foreground: '#f4f4f3' }, // --color-text
        },
    ],
}
import mdx from '@astrojs/mdx'
import sitemap from '@astrojs/sitemap'
import starlight from '@astrojs/starlight'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
    site: 'https://modrex.net',
    integrations: [
        starlight({
            title: 'Modrex',
            description:
                'Documentation for installing, managing, and troubleshooting mods with Modrex.',
            favicon: '/favicon.ico',
            titleDelimiter: '-',
            customCss: ['./src/styles/starlight.css'],
            expressiveCode: {
                themes: [modrexCodeTheme],
                useStarlightUiThemeColors: true,
                styleOverrides: {
                    borderRadius: 'var(--radius-sm)',
                    borderColor: 'var(--color-border)',
                    codeBackground: 'var(--color-surface-raised)',
                    codeFontFamily: 'var(--font-mono)',
                    frames: {
                        frameBoxShadowCssValue: 'none',
                    },
                },
            },
            disable404Route: true,
            components: {
                Head: './src/components/starlight/Head.astro',
                Header: './src/components/starlight/Header.astro',
                Sidebar: './src/components/starlight/Sidebar.astro',
                ThemeProvider: './src/components/starlight/DarkThemeProvider.astro',
            },
            social: [
                { icon: 'github', label: 'GitHub', href: 'https://github.com/modrexio/modrex' },
                { icon: 'discord', label: 'Discord', href: 'https://discord.gg/tenzpx8JRM' },
                { icon: 'x.com', label: 'X', href: 'https://x.com/modrexio' },
                { icon: 'blueSky', label: 'Bluesky', href: 'https://bsky.app/profile/modrex.net' },
            ],
            sidebar: [
                {
                    label: 'Start here',
                    collapsed: true,
                    items: [
                        { label: 'Documentation', link: '/docs/' },
                        { slug: 'docs/getting-started' },
                        { slug: 'docs/contributing' },
                    ],
                },
                {
                    label: 'Games',
                    collapsed: true,
                    items: [{ autogenerate: { directory: 'docs/games' } }],
                },
                {
                    label: 'Concepts',
                    collapsed: true,
                    items: [{ autogenerate: { directory: 'docs/concepts' } }],
                },
                {
                    label: 'Using Modrex',
                    collapsed: true,
                    items: [
                        { slug: 'docs/installing-mods' },
                        { slug: 'docs/organizing' },
                        { slug: 'docs/launching' },
                    ],
                },
                {
                    label: 'Reference',
                    collapsed: true,
                    items: [{ slug: 'docs/settings' }, { slug: 'docs/troubleshooting' }],
                },
            ],
            head: [
                {
                    tag: 'meta',
                    attrs: {
                        name: 'google-site-verification',
                        content: 'BPDEmTr1cgOYsYwW_cXaEN4UAOcAgcVXiVaCAoHunk0',
                    },
                },
                {
                    tag: 'link',
                    attrs: { rel: 'apple-touch-icon', href: '/icon.png' },
                },
                {
                    tag: 'link',
                    attrs: { rel: 'manifest', href: '/site.webmanifest' },
                },
                {
                    tag: 'meta',
                    attrs: { name: 'theme-color', content: '#131313' },
                },
            ],
        }),
        mdx(),
        sitemap({
            filter: (page) => !page.includes('/privacy') && !page.includes('/terms'),
            // Only the homepage gets a lastmod: it renders live release and mod-index data,
            // so it really does change every build. Stamping the build date onto the static
            // docs pages too is the pattern search engines learn to distrust and ignore.
            serialize: (item) =>
                item.url === 'https://modrex.net/'
                    ? { ...item, lastmod: new Date().toISOString() }
                    : item,
        }),
    ],
    vite: {
        plugins: [tailwindcss()],
    },
})
