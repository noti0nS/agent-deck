import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit({
    preprocess: vitePreprocess(),
    adapter: adapter({ pages: 'build', assets: 'build', fallback: 'index.html', precompress: false, strict: false })
  })],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4100',
        changeOrigin: true
      }
    }
  }
});
