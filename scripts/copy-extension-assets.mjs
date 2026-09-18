// Copies build-time-only extension files into dist/ after `vite build`.
// Plain Node, no bundler plugin — code-standards.md: "Do not introduce
// dependencies unless they solve a current V0 requirement."
//
// manifest.json must sit at the extension root for Chrome to load it, and
// it isn't part of the Vite module graph (nothing imports it), so Vite never
// emits it on its own — this script is the only thing that puts it there.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const distDir = join(root, 'dist')

if (!existsSync(distDir)) {
  throw new Error(
    `dist/ does not exist at ${distDir} — run "vite build" before this script.`,
  )
}

const files = [{ from: 'extension/manifest.json', to: 'manifest.json' }]

for (const { from, to } of files) {
  const src = join(root, from)
  const dest = join(distDir, to)
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
  console.log(`copied ${from} -> dist/${to}`)
}
