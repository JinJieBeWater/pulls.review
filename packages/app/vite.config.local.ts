import type { Plugin } from 'vite'
import { fileURLToPath } from 'node:url'
import Vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { defineConfig } from 'vite'
import { LOCAL_HUB_BASE_PATH } from '../core/src/local-rpc'
import { alias, features } from './vite.config.shared'

/**
 * The CLI supplies a static base before any assets. A hub loads this bundle without
 * the CLI's HTML middleware, so retain the page-decided base as a fallback there.
 */
function runtimeBase(): Plugin {
  const script = `if (!document.querySelector('base')) document.write('<base href="' + (location.pathname.startsWith(${JSON.stringify(LOCAL_HUB_BASE_PATH)}) ? ${JSON.stringify(LOCAL_HUB_BASE_PATH)} : '/') + '">')`
  return {
    name: 'pulls-review:runtime-base',
    transformIndexHtml: html => html.replace('<head>', `<head>\n    <script>${script}</script>`),
  }
}

/**
 * The `pulls.review` CLI's SPA (Plan 09): the site with `PR_LOCAL` on, served by its
 * devframe server. Built into the CLI package, next to its server.
 */
export default defineConfig({
  base: './',
  plugins: [
    runtimeBase(),
    Vue(),
    UnoCSS(),
  ],
  resolve: {
    alias,
  },
  define: features({ llm: true, embed: false, local: true }),
  build: {
    outDir: fileURLToPath(new URL('../cli/dist/client', import.meta.url)),
    emptyOutDir: true,
    // Fork (plans/fork/02): the daemon's tab shell at `/`.
    rolldownOptions: { input: { index: fileURLToPath(new URL('index.html', import.meta.url)), shell: fileURLToPath(new URL('shell.html', import.meta.url)) } },
  },
})
