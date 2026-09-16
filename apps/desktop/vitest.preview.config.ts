import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

export default mergeConfig(viteConfig({ mode: 'preview', command: 'serve' }), {
    test: {
        environment: 'jsdom',
        include: ['preview/**/*.test.tsx'],
        // Each test imports the whole renderer afresh, which is seconds on a cold run.
        testTimeout: 20000,
    },
})
