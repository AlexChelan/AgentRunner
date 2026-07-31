import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // A runner and a battery cell are both far slower than a dev box on import-heavy work. Vitest's
    // 5s default reads as a failed assertion when it is really a slow one, and a case that times out
    // mid-import resolves into the NEXT test's state. 30s matches @repo/api and @repo/mail.
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
