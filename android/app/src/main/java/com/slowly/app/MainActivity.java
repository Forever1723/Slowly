package com.slowly.app;

import android.app.Activity;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * Slowly 的安卓外壳。
 * 界面是打包在 assets/index.html 里的离线版：不连电脑也能记，
 * 连上电脑点一次「立即同步」就把两边合并。
 *
 * 继承框架自带的 Activity —— 本项目不依赖 AppCompat，
 * 原因见 app/build.gradle 里的说明。
 */
public class MainActivity extends Activity {

    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        web = findViewById(R.id.web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // localStorage：数据就存在这里
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        web.setBackgroundColor(0xFFF7F2EA);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.addJavascriptInterface(new Bridge(), "SlowlyNative");

        // 站内跳转一律留在 App 内，外部链接交给系统浏览器
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.startsWith("file://") || url.startsWith("about:")) return false;
                try {
                    startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW,
                            android.net.Uri.parse(url)));
                } catch (Exception ignored) { }
                return true;
            }
        });

        web.loadUrl("file:///android_asset/index.html");

        // 如果这次是从扫码链接冷启动的，等页面起来后把配对信息补进去
        deliverPairLinkWhenReady(getIntent());
    }

    /**
     * 扫码配对进来的链接形如：
     *   slowly://pair?token=ABC123&srv=http%3A%2F%2F192.168.1.5%3A8787%2F
     * 把这两个参数交给网页，由网页写进自己的设置里并立刻试同步。
     *
     * 两种时机都要处理：
     *   - App 没开着：链接把 App 拉起来，等页面加载完再注入
     *   - App 已经开着：直接注入，页面立刻生效
     */
    @Override
    protected void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        deliverPairLink(intent);
    }

    /** 从 intent 里取出配对参数并注入网页；不是配对链接就什么都不做 */
    private void deliverPairLink(android.content.Intent intent) {
        if (intent == null || web == null) return;
        android.net.Uri data = intent.getData();
        if (data == null || !"slowly".equals(data.getScheme())) return;

        String token = data.getQueryParameter("token");
        String srv = data.getQueryParameter("srv");
        if (token == null || token.isEmpty()) return;

        // 用 JSON 转义，避免地址里的引号把注入的脚本弄坏
        String js = "window.SlowlyPair && window.SlowlyPair(" +
                org.json.JSONObject.quote(token) + "," +
                org.json.JSONObject.quote(srv == null ? "" : srv) + ")";
        final String script = js;

        web.post(new Runnable() {
            @Override
            public void run() {
                web.evaluateJavascript(script, null);
            }
        });
    }

    /** 页面加载完成后再补一次：App 是被链接冷启动时，onCreate 里注入会太早 */
    private void deliverPairLinkWhenReady(final android.content.Intent intent) {
        if (intent == null || intent.getData() == null) return;
        web.postDelayed(new Runnable() {
            @Override
            public void run() {
                deliverPairLink(intent);
            }
        }, 900);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    /** 网页里通过 window.SlowlyNative 调用，浏览器里访问不到这些方法也不影响 */
    public class Bridge {
        @JavascriptInterface
        public void vibrate(int ms) {
            try {
                Vibrator v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
                if (v == null || !v.hasVibrator()) return;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    v.vibrate(VibrationEffect.createOneShot(Math.max(1, ms), 40));
                } else {
                    v.vibrate(Math.max(1, ms));
                }
            } catch (Exception ignored) { }
        }

        @JavascriptInterface
        public void toast(final String text) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, text, Toast.LENGTH_SHORT).show());
        }

        @JavascriptInterface
        public String platform() {
            return "android";
        }
    }
}
