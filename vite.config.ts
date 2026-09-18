import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// Extension build: the entry point is extension/popup.html, not the
// project-root index.html Vite defaults to. Vite preserves that relative
// path under outDir (-> dist/extension/popup.html); its script/link tags use
// root-absolute paths (/assets/...), which resolve correctly against a
// chrome-extension:// origin regardless of nesting, so no path rewriting is
// needed. scripts/copy-extension-assets.mjs only has to place manifest.json
// at the dist root (manifest.json must always sit at the extension root).
//
// Alias order matters: '@/lib' (root lib/, per code-standards.md § File
// Organization) must be listed before the general '@' -> src/ alias so the
// more specific prefix wins.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@/lib': resolve(import.meta.dirname, './lib'),
      '@': resolve(import.meta.dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(import.meta.dirname, 'extension/popup.html'),
      },
    },
  },
})
