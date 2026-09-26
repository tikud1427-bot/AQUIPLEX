import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const android = path.join(root, 'aqua-frontend', 'android', 'app');

function read(rel) {
  return fs.readFileSync(path.join(android, rel), 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const manifest = read('src/main/AndroidManifest.xml');
const mainActivity = read('src/main/java/com/aquiplex/aqua/MainActivity.java');
const security = read('src/main/java/com/aquiplex/aqua/NativeOAuthSecurity.java');
const capacitor = fs.readFileSync(path.join(root, 'aqua-frontend', 'capacitor.config.ts'), 'utf8');
const generatedCapacitor = read('src/main/assets/capacitor.config.json');
const styles = read('src/main/res/values/styles.xml');
const gradle = read('build.gradle');
const index = fs.readFileSync(path.join(root, 'index.js'), 'utf8');

assert(manifest.includes('android:usesCleartextTraffic="false"'), 'cleartext traffic is not disabled');
assert(manifest.includes('android:autoVerify="true"'), 'HTTPS App Link autoVerify is missing');
assert(manifest.includes('android:scheme="https"'), 'HTTPS App Link scheme missing');
assert(manifest.includes('android:host="aquiplex.com"'), 'App Link host missing');
assert(manifest.includes('android:path="/auth/native/return"'), 'exact OAuth return path missing');
assert(manifest.includes('android.intent.category.BROWSABLE') && manifest.includes('android.intent.category.DEFAULT'), 'App Link categories missing');
assert(manifest.includes('android:launchMode="singleTask"'), 'singleTask is required for OAuth return delivery');
assert(manifest.includes('android:allowBackup="false"'), 'backup must be disabled for sensitive session-bearing app');

assert(capacitor.includes("url: 'https://aquiplex.com/aqua/'"), 'production remote Aqua URL missing from Capacitor source config');
assert(capacitor.includes('cleartext: false'), 'Capacitor cleartext policy missing');
assert(capacitor.includes("errorPath: 'offline.html'"), 'offline error path missing');
assert(generatedCapacitor.includes('https://aquiplex.com/aqua/'), 'generated Capacitor config is stale');
assert(generatedCapacitor.includes('"cleartext": false'), 'generated Capacitor cleartext policy is stale');

assert(styles.includes('windowSplashScreenAnimatedIcon'), 'Android splash icon is not configured');
assert(styles.includes('postSplashScreenTheme'), 'Android splash post-theme missing');
assert(gradle.includes('AQUA_RELEASE_STORE_FILE'), 'release signing is not externally configurable');
assert(mainActivity.includes('generateNonce'), 'native nonce generation is missing');
assert(mainActivity.includes('https://') === false, 'production URL should remain in constants/config, not duplicated as an OAuth client secret');
assert(mainActivity.includes('NATIVE_RETURN_PATH'), 'native return path validation missing');
assert(mainActivity.includes('loadUrl(completionUri.toString())'), 'WebView handoff completion is missing');
assert(mainActivity.includes('WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)'), 'release WebView debugging is not disabled');
assert(mainActivity.includes('MIXED_CONTENT_NEVER_ALLOW'), 'mixed content is not explicitly disabled');
assert(mainActivity.includes('setAllowUniversalAccessFromFileURLs(false)'), 'universal file URL access is not disabled');
assert(security.includes('SecureRandom'), 'native nonce helper is not cryptographically random');
assert(security.includes('MessageDigest.isEqual'), 'nonce binding is not constant-time');

for (const relative of [
  'src/main/res/drawable-nodpi/aqua_logo_launch.png',
  'src/main/res/drawable-nodpi/aqua_launcher_foreground.png',
  'src/main/res/mipmap-mdpi/ic_launcher.png',
  'src/main/res/mipmap-hdpi/ic_launcher.png',
  'src/main/res/mipmap-xhdpi/ic_launcher.png',
  'src/main/res/mipmap-xxhdpi/ic_launcher.png',
  'src/main/res/mipmap-xxxhdpi/ic_launcher.png',
]) {
  assert(fs.existsSync(path.join(android, relative)), `missing Android icon asset: ${relative}`);
}

const forbidden = [
  /GOCSPX-/,
  /mongodb\+srv:\/\//,
  /sk-or-v1-/,
  /gsk_[A-Za-z0-9]/,
  /AIza[A-Za-z0-9_-]{20,}/,
  /rzp_live_/,
  /SESSION_SECRET/i,
  /DATABASE_URL=/,
  /GOOGLE_CLIENT_SECRET/i,
];
const javaAndAssets = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.name === 'build' || entry.name === '.gradle' || entry.name === '.idea') continue;
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && /\.(java|kt|xml|gradle|properties|json|js|ts|html|txt)$/i.test(entry.name)) javaAndAssets.push(full);
  }
}
walk(path.join(root, 'aqua-frontend', 'android'));
for (const file of javaAndAssets) {
  const text = fs.readFileSync(file, 'utf8');
  for (const pattern of forbidden) {
    assert(!pattern.test(text), `possible server secret found in Android tree: ${path.relative(root, file)} / ${pattern}`);
  }
}

assert(index.includes('SHA256_FINGERPRINT_RE'), 'server assetlinks fingerprint validation missing');
assert(index.includes('process.env.PLAY_APP_SIGNING_SHA256'), 'Play signing certificate must come from server environment');
assert(!/08:50:5C:5E:F0:C4:FA:40/.test(index), 'truncated Play signing fingerprint was hardcoded');

console.log('Android release static check: PASS');
console.log('Package: com.aquiplex.aqua');
console.log('App Link: https://aquiplex.com/auth/native/return');
console.log('Web surface: https://aquiplex.com/aqua/');
console.log('Play signing certificate: server-configured at runtime (not hardcoded)');
