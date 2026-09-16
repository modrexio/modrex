import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

export default mergeConfig(viteConfig({ mode: 'preview', command: 'serve' }), {
    test: {
        environment: 'jsdom',
        include: ['preview/**/*.test.tsx'],
    },
})
