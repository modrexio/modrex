import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/**/*.test.{ts,tsx}'],
        exclude: ['src/renderer/preview/**'],
        // happy-dom fetches iframe pages, scripts and stylesheets by default. Mod descriptions
        // embed SoundCloud and Vimeo players, so without this the tests reach the network.
        environmentOptions: {
            happyDOM: {
                settings: {
                    disableIframePageLoading: true,
                    disableJavaScriptFileLoading: true,
                    disableCSSFileLoading: true,
                },
            },
        },
    },
})
