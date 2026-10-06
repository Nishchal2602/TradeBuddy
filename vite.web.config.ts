import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// Web dashboard build — deliberately a SEPARATE config from vite.config.ts,
// not a second entry on it. The extension config has emptyOutDir: true
// pointed at dist/; sharing it would mean one build's output could wipe or
// mix into the other's. A separate config + separate outDir (dist-web/)
// keeps `npm run build`'s output byte-identical, which is the literal
// instruction behind this app's existence (see WEB-1 plan, "What does NOT
// change").
//
// base: './' (relative asset URLs), unlike the extension bundle's
// root-absolute /assets/... — correct there because chrome-extension:// is
// always an origin root; wrong here, since this is meant to be deployable
// as a static site at any subpath.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: resolve(import.meta.dirname, 'src/web'),
  base: './',
  resolve: {
    alias: {
      '@/lib': resolve(import.meta.dirname, './lib'),
      '@': resolve(import.meta.dirname, './src'),
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, 'dist-web'),
    emptyOutDir: true,
  },
  server: {
    port: 5174, // 5173 is the extension's own dev server (.claude/launch.json)
  },
})
