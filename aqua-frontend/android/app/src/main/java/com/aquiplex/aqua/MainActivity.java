package com.aquiplex.aqua;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.animation.ValueAnimator;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.RectF;
import android.graphics.Shader;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.view.animation.DecelerateInterpolator;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;


/**
 * Premium native shell around the existing Aqua web application.
 *
 * The web application/backend remain the product source of truth. Native code
 * adds Android lifecycle, OAuth handoff, secure App Links, downloads, system
 * UI, and a short launch transition only.
 */
public class MainActivity extends BridgeActivity {
    private static final String PRODUCTION_HOST = "aquiplex.com";
    private static final String PRODUCTION_SCHEME = "https";
    private static final String AQUA_PATH = "/aqua";
    private static final String GOOGLE_PATH = "/auth/google";
    private static final String NATIVE_RETURN_PATH = "/auth/native/return";
    private static final String NATIVE_COMPLETE_PATH = "/auth/native/complete";
    private static final String NATIVE_PREFS = "aqua_native_oauth";
    private static final String KEY_PENDING_NONCE = "pending_nonce";
    private static final String KEY_NONCE_CREATED_AT = "nonce_created_at";
    private static final long LAUNCH_OVERLAY_MAX_MS = 1200L;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private FrameLayout launchOverlay;
    private AquaLaunchView launchView;
    private boolean launchOverlayFinished;
    private Runnable launchTimeout;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        SplashScreen.installSplashScreen(this);
        super.onCreate(savedInstanceState);

        configureSystemUi();
        installNativeLaunchOverlay();
        installWebViewShell();
        installBackNavigation();
        handleOAuthReturn(getIntent());
    }

    private void installWebViewShell() {
        if (getBridge() == null || getBridge().getWebView() == null) return;

        WebView webView = getBridge().getWebView();
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true); // Aqua is a React application.
        settings.setDomStorageEnabled(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setGeolocationEnabled(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(true);
        }

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        webView.setDownloadListener(new AquaDownloadListener(this));
        webView.setWebViewClient(new AquaWebViewClient(getBridge()));
        webView.setBackgroundColor(isDarkMode() ? Color.rgb(11, 14, 18) : Color.rgb(250, 250, 248));
    }

    private void installBackNavigation() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (getBridge() == null || getBridge().getWebView() == null) {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                    return;
                }

                WebView webView = getBridge().getWebView();
                if (webView.canGoBack()) {
                    webView.goBack();
                    return;
                }

                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
            }
        });
    }

    private void configureSystemUi() {
        Window window = getWindow();
        WindowCompat.enableEdgeToEdge(window);
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.TRANSPARENT);
            window.setNavigationBarContrastEnforced(false);
        }

        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        boolean dark = isDarkMode();
        controller.setAppearanceLightStatusBars(!dark);
        controller.setAppearanceLightNavigationBars(!dark);
    }

    private boolean isDarkMode() {
        int nightMode = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return nightMode == Configuration.UI_MODE_NIGHT_YES;
    }

    private void installNativeLaunchOverlay() {
        View content = findViewById(android.R.id.content);
        if (!(content instanceof ViewGroup)) return;

        launchOverlay = new FrameLayout(this);
        launchOverlay.setBackgroundColor(isDarkMode() ? Color.rgb(11, 14, 18) : Color.rgb(250, 250, 248));
        launchOverlay.setClickable(true);
        launchOverlay.setFocusable(false);

        launchView = new AquaLaunchView(this);
        int size = dp(184);
        FrameLayout.LayoutParams logoParams = new FrameLayout.LayoutParams(size, size);
        logoParams.gravity = android.view.Gravity.CENTER;
        launchOverlay.addView(launchView, logoParams);

        ((ViewGroup) content).addView(
                launchOverlay,
                new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        launchView.startMotion(animationsEnabled());
        launchTimeout = this::finishLaunchOverlay;
        mainHandler.postDelayed(launchTimeout, LAUNCH_OVERLAY_MAX_MS);
    }

    private boolean animationsEnabled() {
        try {
            float animatorScale = Settings.Global.getFloat(
                    getContentResolver(), Settings.Global.ANIMATOR_DURATION_SCALE, 1f);
            return animatorScale > 0f;
        } catch (Exception ignored) {
            return true;
        }
    }

    private void finishLaunchOverlay() {
        if (launchOverlayFinished || launchOverlay == null) return;
        launchOverlayFinished = true;
        if (launchTimeout != null) mainHandler.removeCallbacks(launchTimeout);

        if (!animationsEnabled()) {
            removeLaunchOverlay();
            return;
        }

        launchOverlay.animate()
                .alpha(0f)
                .setDuration(220L)
                .setInterpolator(new DecelerateInterpolator())
                .setListener(new AnimatorListenerAdapter() {
                    @Override
                    public void onAnimationEnd(Animator animation) {
                        removeLaunchOverlay();
                    }
                })
                .start();
    }

    private void removeLaunchOverlay() {
        if (launchOverlay == null) return;
        if (launchView != null) launchView.stopMotion();
        ViewGroup parent = (ViewGroup) launchOverlay.getParent();
        if (parent != null) parent.removeView(launchOverlay);
        launchOverlay = null;
        launchView = null;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private SharedPreferences oauthPrefs() {
        return getSharedPreferences(NATIVE_PREFS, Context.MODE_PRIVATE);
    }

    private String createNativeNonce() {
        String nonce = NativeOAuthSecurity.generateNonce();
        oauthPrefs().edit()
                .putString(KEY_PENDING_NONCE, nonce)
                .putLong(KEY_NONCE_CREATED_AT, System.currentTimeMillis())
                .apply();
        return nonce;
    }

    private void clearPendingNonce() {
        oauthPrefs().edit().remove(KEY_PENDING_NONCE).remove(KEY_NONCE_CREATED_AT).apply();
    }

    private void beginNativeGoogleAuth(Uri originalUri) {
        String nonce = createNativeNonce();
        Uri.Builder builder = new Uri.Builder()
                .scheme(PRODUCTION_SCHEME)
                .authority(PRODUCTION_HOST)
                .path(GOOGLE_PATH)
                .appendQueryParameter("native", "1")
                .appendQueryParameter("nonce", nonce);

        // Preserve only the server-supported post-login target. Do not carry
        // arbitrary OAuth/browser query parameters into the native handshake.
        String next = originalUri.getQueryParameter("next");
        if (next != null && !next.isEmpty()) builder.appendQueryParameter("next", next);

        try {
            Intent browserIntent = new Intent(Intent.ACTION_VIEW, builder.build());
            browserIntent.addCategory(Intent.CATEGORY_BROWSABLE);
            startActivity(browserIntent);
        } catch (ActivityNotFoundException ex) {
            clearPendingNonce();
            Toast.makeText(this, "Sign-in couldn't be completed. Try again.", Toast.LENGTH_LONG).show();
        }
    }

    private boolean handleOAuthReturn(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction()) || intent.getData() == null) {
            return false;
        }

        Uri uri = intent.getData();
        boolean looksLikeNativeReturn = PRODUCTION_SCHEME.equalsIgnoreCase(uri.getScheme())
                && PRODUCTION_HOST.equalsIgnoreCase(uri.getHost())
                && NATIVE_RETURN_PATH.equals(uri.getPath());
        if (!looksLikeNativeReturn) return false;

        String code = uri.getQueryParameter("code");
        String nonce = uri.getQueryParameter("nonce");
        SharedPreferences prefs = oauthPrefs();
        String expectedNonce = prefs.getString(KEY_PENDING_NONCE, null);
        long createdAt = prefs.getLong(KEY_NONCE_CREATED_AT, 0L);

        boolean valid = NativeOAuthSecurity.isValidReturn(
                uri.getScheme(),
                uri.getHost(),
                uri.getPath(),
                code,
                nonce,
                expectedNonce,
                createdAt,
                System.currentTimeMillis());

        if (!valid) {
            if (expectedNonce != null && NativeOAuthSecurity.constantTimeEquals(expectedNonce, nonce)) {
                clearPendingNonce();
            }
            intent.setData(null);
            Toast.makeText(this, "Sign-in couldn't be completed. Try again.", Toast.LENGTH_LONG).show();
            return true;
        }

        // Consume the local nonce before touching the WebView. The server-side
        // code is independently one-time, so this blocks duplicate app intents
        // from re-running the same client-side handoff.
        clearPendingNonce();
        intent.setData(null);
        intent.setAction(null);

        Uri completionUri = new Uri.Builder()
                .scheme(PRODUCTION_SCHEME)
                .authority(PRODUCTION_HOST)
                .path(NATIVE_COMPLETE_PATH)
                .appendQueryParameter("code", code)
                .build();

        if (getBridge() == null || getBridge().getWebView() == null) {
            Toast.makeText(this, "Sign-in couldn't be completed. Try again.", Toast.LENGTH_LONG).show();
            return true;
        }

        getBridge().getWebView().post(() -> getBridge().getWebView().loadUrl(completionUri.toString()));
        return true;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        setIntent(intent);
        if (handleOAuthReturn(intent)) return;
        super.onNewIntent(intent);
    }

    private final class AquaWebViewClient extends BridgeWebViewClient {
        AquaWebViewClient(com.getcapacitor.Bridge bridge) {
            super(bridge);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
            Uri url = request.getUrl();
            if (isAquaGoogleStart(url)) {
                beginNativeGoogleAuth(url);
                return true;
            }
            return super.shouldOverrideUrlLoading(view, request);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            Uri parsed = Uri.parse(url);
            if (isAquaGoogleStart(parsed)) {
                beginNativeGoogleAuth(parsed);
                return true;
            }
            return super.shouldOverrideUrlLoading(view, url);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            Uri parsed = Uri.parse(url);
            if (PRODUCTION_HOST.equalsIgnoreCase(parsed.getHost()) && parsed.getPath() != null) {
                if (parsed.getPath().equals(AQUA_PATH) || parsed.getPath().startsWith(AQUA_PATH + "/")) {
                    view.post(MainActivity.this::finishLaunchOverlay);
                }
            }
        }

        private boolean isAquaGoogleStart(Uri uri) {
            return PRODUCTION_SCHEME.equalsIgnoreCase(uri.getScheme())
                    && PRODUCTION_HOST.equalsIgnoreCase(uri.getHost())
                    && GOOGLE_PATH.equals(uri.getPath());
        }
    }

    private static final class AquaDownloadListener implements DownloadListener {
        private final Context context;

        AquaDownloadListener(Context context) {
            this.context = context;
        }

        @Override
        public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimeType, long contentLength) {
            Uri uri = Uri.parse(url);
            if (!PRODUCTION_HOST.equalsIgnoreCase(uri.getHost())) {
                try {
                    context.startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException ignored) {
                    Toast.makeText(context, "Download couldn't be opened. Try again.", Toast.LENGTH_LONG).show();
                }
                return;
            }

            try {
                DownloadManager.Request request = new DownloadManager.Request(uri);
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setAllowedOverMetered(true);
                request.setAllowedOverRoaming(false);
                if (mimeType != null && !mimeType.isEmpty()) request.setMimeType(mimeType);

                String filename = android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType);
                filename = sanitizeFilename(filename);
                request.setTitle(filename);
                request.setDescription("Aqua AI");
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename);

                String cookies = CookieManager.getInstance().getCookie(url);
                if (cookies != null && !cookies.isEmpty()) request.addRequestHeader("Cookie", cookies);
                if (userAgent != null && !userAgent.isEmpty()) request.addRequestHeader("User-Agent", userAgent);

                DownloadManager manager = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
                if (manager == null) throw new IllegalStateException("Download manager unavailable");
                manager.enqueue(request);
                Toast.makeText(context, "Download started", Toast.LENGTH_SHORT).show();
            } catch (Exception ex) {
                Toast.makeText(context, "Download couldn't be started. Try again.", Toast.LENGTH_LONG).show();
            }
        }

        private static String sanitizeFilename(String filename) {
            String safe = filename == null ? "aqua-download" : filename.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
            if (safe.isEmpty()) safe = "aqua-download";
            return safe.length() > 180 ? safe.substring(0, 180) : safe;
        }
    }

    private static final class AquaLaunchView extends View {
        private final Paint bitmapPaint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        private final Paint shimmerPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Bitmap logo;
        private final RectF logoRect = new RectF();
        private ValueAnimator shimmerAnimator;
        private float shimmerProgress = -0.4f;

        AquaLaunchView(Context context) {
            super(context);
            logo = BitmapFactory.decodeResource(getResources(), R.drawable.aqua_logo_launch);
            setLayerType(View.LAYER_TYPE_SOFTWARE, null);
        }

        void startMotion(boolean animate) {
            setScaleX(0.94f);
            setScaleY(0.94f);
            setAlpha(0.96f);
            if (!animate) return;
            animate().scaleX(1.0f).scaleY(1.0f).alpha(1f).setDuration(650L).setInterpolator(new DecelerateInterpolator()).start();

            shimmerAnimator = ValueAnimator.ofFloat(-0.35f, 1.35f);
            shimmerAnimator.setDuration(1100L);
            shimmerAnimator.setStartDelay(130L);
            shimmerAnimator.setRepeatCount(1);
            shimmerAnimator.setInterpolator(new DecelerateInterpolator());
            shimmerAnimator.addUpdateListener(animation -> {
                shimmerProgress = (Float) animation.getAnimatedValue();
                invalidate();
            });
            shimmerAnimator.start();
        }

        void stopMotion() {
            if (shimmerAnimator != null) shimmerAnimator.cancel();
        }

        @Override
        protected void onDraw(@NonNull Canvas canvas) {
            super.onDraw(canvas);
            if (logo == null) return;

            float width = logo.getWidth();
            float height = logo.getHeight();
            float scale = Math.min(getWidth() / width, getHeight() / height) * 0.88f;
            float drawW = width * scale;
            float drawH = height * scale;
            float left = (getWidth() - drawW) / 2f;
            float top = (getHeight() - drawH) / 2f;
            logoRect.set(left, top, left + drawW, top + drawH);
            canvas.drawBitmap(logo, null, logoRect, bitmapPaint);

            if (shimmerAnimator != null && shimmerAnimator.isRunning()) {
                float start = logoRect.left + shimmerProgress * logoRect.width();
                float band = Math.max(logoRect.width() * 0.12f, 24f);
                shimmerPaint.setShader(new LinearGradient(
                        start - band,
                        0,
                        start + band,
                        0,
                        new int[]{0x00000000, 0x30FFFFFF, 0x00000000},
                        new float[]{0f, 0.5f, 1f},
                        Shader.TileMode.CLAMP));
                shimmerPaint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.SRC_ATOP));
                int save = canvas.saveLayer(logoRect, null);
                canvas.drawBitmap(logo, null, logoRect, bitmapPaint);
                canvas.drawRect(logoRect, shimmerPaint);
                canvas.restoreToCount(save);
                shimmerPaint.setXfermode(null);
                shimmerPaint.setShader(null);
            }
        }
    }
}
