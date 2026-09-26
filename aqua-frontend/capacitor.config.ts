import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.aquiplex.aqua',
  appName: 'Aqua AI',
  webDir: 'dist',
  server: {
    // Android is a native shell around the production Aqua web app. This keeps
    // the existing web UI, routes, session cookies and backend as the source
    // of truth instead of creating a second mobile implementation.
    url: 'https://aquiplex.com/aqua/',
    cleartext: false,
    errorPath: 'offline.html',
  },
};

export default config;
