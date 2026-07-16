import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { VitePWA } from 'vite-plugin-pwa';

// P0 (cache) — one id per build, stamped into BOTH the bundle (__BUILD_ID__)
// and dist/index.html (<meta name="aqua-build">). The server exposes the html
// stamp at /aqua/build.json; the running app compares it against its own
// baked-in id and hard-reloads on mismatch. See src/hooks/useVersionGuard.ts.
const BUILD_ID = new Date().toISOString().replace(/[:.]/g, '-');

function buildStamp() {
  return {
    name: 'aqua-build-stamp',
    transformIndexHtml(html: string) {
      return html.replace(
        '</title>',
        `</title>\n    <meta name="aqua-build" content="${BUILD_ID}" />`,
      );
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  base: '/aqua/',
  plugins: [
    react(),
    tailwindcss(),
    buildStamp(),
    VitePWA({
      // App is mounted at /aqua/ (see `base` above) — plugin derives
      // start_url/scope/sw scope from it automatically.
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: [
        'favicon.ico',
        'favicon.svg',
        'favicon-96x96.png',
        'apple-touch-icon.png',
      ],
      manifest: {
        id: '/aqua/',
        name: 'AQUA — AI Assistant for AQUIPLEX',
        short_name: 'AQUA',
        description: 'AQUA — the AI assistant for AQUIPLEX.',
        start_url: '/aqua/',
        scope: '/aqua/',
        display: 'standalone',
        orientation: 'portrait-primary',
        theme_color: '#0F172A',
        background_color: '#0F172A',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache built static assets only — no runtime caching of
        // API/auth/chat endpoints.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webp,woff,woff2}'],
        navigateFallback: '/aqua/index.html',
        navigateFallbackDenylist: [/^\/(?!aqua\/)/],
        cleanupOutdatedCaches: true,
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    host: true,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-motion': ['framer-motion'],
          'vendor-radix': [
            '@radix-ui/react-avatar',
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-popover',
            '@radix-ui/react-scroll-area',
            '@radix-ui/react-separator',
            '@radix-ui/react-switch',
            '@radix-ui/react-tabs',
            '@radix-ui/react-tooltip',
            '@radix-ui/react-slot',
          ],
          'vendor-markdown': ['react-markdown', 'remark-gfm'],
        },
      },
    },
  },
});
