import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // relative paths so the packed .ehpk works offline
  server: { host: true, port: 5173, strictPort: true },
});
