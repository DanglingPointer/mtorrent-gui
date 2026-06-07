import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        setupFiles: ['./tests/test-setup.js'],
        include: ['tests/**/*.test.js'],
    },
});
