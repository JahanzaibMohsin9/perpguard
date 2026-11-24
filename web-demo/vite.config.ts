import { defineConfig } from 'vite';

// Static "try it" page for GitHub Pages. It reuses the real glasses card renderer and the real
// Hyperliquid read code, and talks to Hyperliquid's public API straight from the browser.
export default defineConfig({
  base: './',
  server: { port: 5174, fs: { allow: ['..'] } },
  build: { outDir: 'dist', emptyOutDir: true },
});
