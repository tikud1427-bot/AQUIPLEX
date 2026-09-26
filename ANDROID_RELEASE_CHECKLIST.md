# Aqua AI Android release checklist

## Audited source of truth

The existing React/Vite Aqua application remains the UI and routing source of truth. The Android project is a Capacitor shell around `https://aquiplex.com/aqua/`; the backend remains authoritative for authentication, sessions, AI, memory, files, billing and entitlements.

## Implemented

- HTTPS production `server.url` with cleartext disabled and local offline fallback.
- Verified HTTPS App Link for `com.aquiplex.aqua` and `/auth/native/return`.
- Native Google OAuth launch nonce generated with `SecureRandom`; nonce is persisted only until the browser return and validated with constant-time comparison.
- Native return validates scheme, host, exact path, nonce, code length and expiry before asking the WebView to redeem `/auth/native/complete`.
- Existing backend one-time native handoff code remains authoritative; no provider secret or token is placed in Android.
- Mongo-backed 30-day rolling server session remains authoritative; no local-storage login replacement was introduced.
- Android 12+ SplashScreen API plus a short offline-capable Aqua logo launch transition with reduced-motion handling.
- Native downloads for authenticated Aqua-hosted files, browser handling for other hosts, safe WebView settings, edge-to-edge system UI and Android back handling.
- App launcher, adaptive, round and PWA icon assets generated from the supplied Aqua logo without changing the logo artwork.
- Instrumentation/unit coverage corrected for the real package and native OAuth security helpers added.
- Release signing is optional via Gradle properties so the existing out-of-band upload key can be used without committing it.

## Production configuration still external

Confirmed from Play Console → App signing (2026-09-26), read in full, not from a truncated screenshot:

- Play App Signing certificate, SHA-256: `08:50:5C:5E:F0:C4:FA:40:DC:14:E2:D2:41:48:83:88:2D:47:46:C0:5F:9B:E4:5D:6F:AB:B4:48:9B:9F:65:FB`
- Upload key certificate, SHA-256: `15:F7:A9:A8:72:79:D4:39:1F:DE:E5:5A:7E:02:B0:D2:9D:56:57:CB:AC:17:F0:CA:0F:ED:61:F4:B1:40:1C:2B` — already matches the `AQUA_ANDROID_UPLOAD_KEY_SHA256` constant hardcoded in `index.js`.

Action still required outside this repo: set `PLAY_APP_SIGNING_SHA256` to the App Signing value above as a Render environment variable on the production service. `index.js` reads it from `process.env` at startup (`readPlaySigningFingerprints`) — intentionally not hardcoded, so `scripts/android-release-check.mjs` fails the build if a Play signing fingerprint ever gets committed to source. Cert fingerprints aren't secrets (they're published in `assetlinks.json` for anyone to fetch), so this value is safe to keep in this doc and in the Render dashboard; it doesn't need `SESSION_SECRET`/`GOOGLE_CLIENT_SECRET`-level handling.

### Icon/splash PNGs regenerated 2026-09-26

The handoff tarball for this session had zero `.png` files anywhere in the tree (`aqua-frontend/public/favicon.ico` and `favicon.svg` survived; every `.png`, including the ones this file already claimed were generated, did not). Root cause looked like a transfer/packaging step stripping PNGs, not a real repo regression. Recovered the official mark from `aqua-frontend/public/favicon.svg`'s embedded base64 PNG (1254×1254, flattened onto white by the RealFaviconGenerator export) rather than drawing a new one, then:

- Legacy `mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png` — direct resize of the flattened master (white background + baked shadow preserved as-is).
- `ic_launcher_round.png` at the same five densities — circular crop of the same flattened master; verified the mark's content radius (518px) sits well inside the inscribed-circle radius (627px) at source resolution, so nothing is clipped.
- `drawable-nodpi/aqua_launcher_foreground.png` (432×432) and `aqua_logo_launch.png` (960×960) — background/shadow chroma-keyed to transparent (soft threshold on distance-from-white, not a hard cutout, so the shadow fades naturally instead of a hard edge), trimmed, and re-centered at a 66%/70% safe-zone fill so the adaptive-icon mask and the splash frame don't crop it.
- No hue, geometry, or artwork changes — same logo, just isolated and resized. `node scripts/android-release-check.mjs` → `PASS` after adding these.

If a future handoff is missing PNGs again, `aqua-frontend/public/favicon.svg`'s embedded base64 payload is the fallback recovery path before asking for the source logo again.

## Release commands

From `aqua-frontend/` after dependencies are installed and on a machine with the Android SDK:

```bash
npm run build
npx cap sync android
cd android
./gradlew test lint bundleRelease
```

For a signed AAB, provide the existing upload-key properties out-of-band: `AQUA_RELEASE_STORE_FILE`, `AQUA_RELEASE_STORE_PASSWORD`, `AQUA_RELEASE_KEY_ALIAS`, `AQUA_RELEASE_KEY_PASSWORD`. Do not create a new Play signing identity.

## Play validation

1. Set `PLAY_APP_SIGNING_SHA256=08:50:5C:5E:F0:C4:FA:40:DC:14:E2:D2:41:48:83:88:2D:47:46:C0:5F:9B:E4:5D:6F:AB:B4:48:9B:9F:65:FB` as a Render environment variable on the production service and redeploy.
2. Verify `https://aquiplex.com/.well-known/assetlinks.json` contains `com.aquiplex.aqua` and the exact Play certificate.
3. Increment `versionCode` above the currently published Play version; the repository only contains a default `1` and no authoritative Play history, so this was deliberately not guessed.
4. Upload the signed AAB to an Internal testing track.
5. Test fresh Google login, returning-user login, browser-to-app return, restart/background/process recreation, file upload/download and App Link verification on a Play-installed build.
6. After Play installation, verify App Links with Android's link-state tooling and retest native OAuth.
