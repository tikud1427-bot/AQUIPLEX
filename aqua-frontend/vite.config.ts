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
        'offline.html',
      ],
      manifest: {
        id: '/aqua/',
        name: 'AQUA — AI Assistant for AQUIPLEX',
        short_name: 'AQUA',
        description: 'AQUA — the AI assistant for AQUIPLEX.',
        start_url: '/aqua/',
        scope: '/aqua/',
        display: 'standalone',
        display_override: ['standalone', 'minimal-ui'],
        orientation: 'portrait-primary',
        theme_color: '#0F172A',
        background_color: '#0F172A',
        lang: 'en',
        categories: ['productivity', 'utilities', 'education'],
        // "any" purpose — full-bleed brand icon at all standard PWABuilder/
        // Android sizes. "maskable" purpose — same mark on an 80%-safe-zone
        // canvas so Android/Play can crop to circle/squircle without
        // clipping the logo. Kept as separate files (see public/) rather
        // than reusing the any-purpose icon for both purposes.
        icons: [
          { src: 'pwa-72x72.png', sizes: '72x72', type: 'image/png', purpose: 'any' },
          { src: 'pwa-96x96.png', sizes: '96x96', type: 'image/png', purpose: 'any' },
          { src: 'pwa-128x128.png', sizes: '128x128', type: 'image/png', purpose: 'any' },
          { src: 'pwa-144x144.png', sizes: '144x144', type: 'image/png', purpose: 'any' },
          { src: 'pwa-152x152.png', sizes: '152x152', type: 'image/png', purpose: 'any' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-256x256.png', sizes: '256x256', type: 'image/png', purpose: 'any' },
          { src: 'pwa-384x384.png', sizes: '384x384', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'maskable-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // Shortcuts map only to routes that exist in src/routes/router.tsx —
        // no new pages/features added. "AI Search" / "Recent Chats" from the
        // original spec were skipped: there's no dedicated route for either
        // today (search doesn't exist; recents live in the sidebar, not a
        // route), and fabricating shortcut targets would misrepresent the
        // app in the install/Play listing.
        shortcuts: [
          {
            name: 'New Chat',
            short_name: 'New Chat',
            url: '/aqua/',
            description: 'Start a new AQUA conversation',
          },
          {
            name: 'Mind',
            short_name: 'Mind',
            url: '/aqua/mind',
            description: "Open AQUA's memory & reasoning view",
          },
        ],
      },
      workbox: {
        // Precache built static assets only — no runtime caching of
        // API/auth/chat endpoints.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webp,woff,woff2}'],
        navigateFallback: '/aqua/index.html',
        navigateFallbackDenylist: [/^\/(?!aqua\/)/],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Google Fonts stylesheet — small, changes rarely.
            urlPattern: /^https:\/\/fonts\.googleapis\.com\//,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'aqua-google-fonts-stylesheets' },
          },
          {
            // Google Fonts font files — immutable, safe to cache-first for a year.
            urlPattern: /^https:\/\/fonts\.gstatic\.com\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'aqua-google-fonts-webfonts',
              expiration: { maxAgeSeconds: 60 * 60 * 24 * 365, maxEntries: 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
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
