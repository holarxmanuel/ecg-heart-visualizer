package stream.ecgv.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.res.AssetManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.widget.FrameLayout;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

// ECGV on a phone. Unlike the hosted site, the whole interface (simulator,
// filters, R-peak detector, 3D heart) is packed inside the APK and served to
// the WebView from it, at the real https://ecgv.stream origin. So the app
// opens and simulates with no network at all, the first time included, while
// /api and the live WebSocket still reach the server whenever it is online.
public class MainActivity extends Activity {
    static java.lang.ref.WeakReference<MainActivity> current = new java.lang.ref.WeakReference<>(null);
    static final String HOST = BuildConfig.HOST;
    WebView web;
    private boolean revealed = false;
    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html"); MIME.put("js", "text/javascript"); MIME.put("mjs", "text/javascript");
        MIME.put("css", "text/css"); MIME.put("json", "application/json"); MIME.put("webmanifest", "application/manifest+json");
        MIME.put("png", "image/png"); MIME.put("svg", "image/svg+xml"); MIME.put("jpg", "image/jpeg"); MIME.put("webp", "image/webp");
        MIME.put("woff", "font/woff"); MIME.put("woff2", "font/woff2"); MIME.put("wav", "audio/wav"); MIME.put("mp3", "audio/mpeg");
        MIME.put("ico", "image/x-icon"); MIME.put("txt", "text/plain"); MIME.put("wasm", "application/wasm");
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        current = new java.lang.ref.WeakReference<>(this);
        // A monitor should not dim while you watch it.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        web = new WebView(this);
        web.setBackgroundColor(Color.TRANSPARENT);
        web.setVisibility(View.INVISIBLE);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF07090D);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        // Android 15+ draws edge to edge: keep the page clear of the bars and cut-out.
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            return WindowInsetsCompat.CONSUMED;
        });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);   // heart sounds
        s.setSupportZoom(false);
        s.setUserAgentString(s.getUserAgentString() + " ECGVApp/" + BuildConfig.VERSION_NAME);
        web.addJavascriptInterface(new Bridge(this), "EcgvNative");
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) { return fromApk(r); }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (HOST.equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }
            @Override public void onPageFinished(WebView v, String url) { v.postDelayed(MainActivity.this::reveal, 400); }
        });
        web.loadUrl("https://" + HOST + "/");
    }

    // The interface comes from the APK; anything not in it (the API, the live
    // stream, downloads) goes to the network as usual.
    private WebResourceResponse fromApk(WebResourceRequest r) {
        Uri u = r.getUrl();
        if (!HOST.equals(u.getHost()) || !"GET".equals(r.getMethod())) return null;
        String path = u.getPath() == null ? "/" : u.getPath();
        if (path.startsWith("/api/") || path.startsWith("/ws/") || path.startsWith("/download/")) return null;
        if (path.equals("/") || path.isEmpty()) path = "/index.html";
        AssetManager am = getAssets();
        try {
            InputStream in = am.open("web" + path);
            String ext = path.contains(".") ? path.substring(path.lastIndexOf('.') + 1).toLowerCase() : "";
            String mime = MIME.getOrDefault(ext, "application/octet-stream");
            WebResourceResponse res = new WebResourceResponse(mime, mime.startsWith("text/") || mime.contains("json") || mime.contains("javascript") ? "utf-8" : null, in);
            Map<String, String> h = new HashMap<>();
            h.put("Cache-Control", "no-cache");
            h.put("Access-Control-Allow-Origin", "*");
            res.setResponseHeaders(h);
            return res;
        } catch (Exception notInApk) {
            return null;
        }
    }

    private void reveal() {
        if (revealed) return;
        revealed = true;
        web.setVisibility(View.VISIBLE);
        web.setAlpha(0f);
        web.animate().alpha(1f).setDuration(180).withEndAction(() -> {
            web.setBackgroundColor(0xFF07090D);
            getWindow().setBackgroundDrawableResource(R.color.ink);
        }).start();
    }

    @Override public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else moveTaskToBack(true);
    }

    @Override protected void onResume() {
        super.onResume();
        if (web != null) web.evaluateJavascript("window.dispatchEvent(new Event('ecgv-native'))", null);
        Updater.resumeIfWaiting(this);
    }

    void updateEvent(String state, int progress, String message) {
        String js = "window.dispatchEvent(new CustomEvent('ecgv-update',{detail:{state:" + q(state) + ",progress:" + progress + ",message:" + q(message) + "}}))";
        runOnUiThread(() -> web.evaluateJavascript(js, null));
    }
    private static String q(String s) { return s == null ? "null" : org.json.JSONObject.quote(s); }
}
