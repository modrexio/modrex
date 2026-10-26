import { defineConfig, fontProviders } from 'astro/config'

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
import devSearch from './src/integrations/dev-search'

const previewNumber = process.env.SITE_PREVIEW_PR
if (previewNumber && !/^[1-9]\d*$/.test(previewNumber)) {
    throw new Error('SITE_PREVIEW_PR must be a positive pull request number')
}
const base = previewNumber ? `/pr/${previewNumber}/` : '/'

export default defineConfig({
    site: previewNumber ? 'https://site-preview.modrex.net' : 'https://modrex.net',
    base,
    fonts: [
        {
            provider: fontProviders.local(),
            name: 'Bebas Neue',
            cssVariable: '--font-bebas-neue',
            fallbacks: ['Oswald', 'Arial Narrow', 'sans-serif'],
            options: {
                variants: [
                    {
                        src: ['./src/assets/fonts/bebas-neue-latin-400-normal.woff2'],
                        weight: 400,
                        style: 'normal',
                        unicodeRange: [
                            'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
                        ],
                    },
                    {
                        src: ['./src/assets/fonts/bebas-neue-latin-ext-400-normal.woff2'],
                        weight: 400,
                        style: 'normal',
                        unicodeRange: [
                            'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
                        ],
                    },
                ],
            },
        },
    ],
    integrations: [
        starlight({
            title: 'Modrex',
            description:
                'Documentation for installing, managing, and troubleshooting mods with Modrex.',
            favicon: '/favicon.ico',
            titleDelimiter: '|',
            customCss: ['./src/styles/starlight.css'],
            expressiveCode: {
                themes: [modrexCodeTheme],
                useStarlightUiThemeColors: true,
                // Wrapped code never scrolls sideways, see Scrollbars.astro.
                defaultProps: { wrap: true },
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
                TableOfContents: './src/components/starlight/TableOfContents.astro',
                ThemeProvider: './src/components/starlight/DarkThemeProvider.astro',
            },
            social: [
                { icon: 'github', label: 'GitHub', href: 'https://github.com/modrexio/modrex' },
                { icon: 'discord', label: 'Discord', href: 'https://discord.gg/QM2rDgy43Y' },
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
                    attrs: { rel: 'apple-touch-icon', href: `${base}icon.png` },
                },
                {
                    tag: 'link',
                    attrs: { rel: 'manifest', href: `${base}site.webmanifest` },
                },
                {
                    tag: 'meta',
                    attrs: { name: 'theme-color', content: '#131313' },
                },
            ],
        }),
        mdx(),
        devSearch(),
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
