package com.codexa.wrapper;

import android.app.Activity;
import android.app.DownloadManager;
import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.util.Base64;
import android.view.View;
import android.webkit.MimeTypeMap;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.PermissionRequest;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.URLUtil;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

public final class MainActivity extends Activity {
    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static final int FILE_CHOOSER_RESULT_CODE = 1001;
    private static final int WEB_PERMISSION_RESULT_CODE = 1002;
    private static final int GEOLOCATION_RESULT_CODE = 1003;
    private static final int SAVE_DOWNLOAD_RESULT_CODE = 1004;
    private static final int LEGACY_DOWNLOAD_PERMISSION_RESULT_CODE = 1005;
    private WebView webView;
    private boolean allowExternalNetwork;
    private ValueCallback<Uri[]> filePathCallback;
    private PermissionRequest pendingWebPermission;
    private String[] pendingWebResources;
    private GeolocationPermissions.Callback pendingGeolocationCallback;
    private String pendingGeolocationOrigin;
    private PendingDownload pendingDownload;
    private String[] pendingRemoteDownload;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        allowExternalNetwork = readNetworkPermission();
        getWindow().setStatusBarColor(Color.rgb(16, 19, 15));
        getWindow().setNavigationBarColor(Color.rgb(16, 19, 15));
        getWindow().getDecorView().setSystemUiVisibility(0);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.WHITE);
        webView.setOverScrollMode(View.OVER_SCROLL_IF_CONTENT_SCROLLS);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        // The system picker returns content:// URIs for the file explicitly selected by the user.
        settings.setAllowContentAccess(true);
        settings.setGeolocationEnabled(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) settings.setSafeBrowsingEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(true);
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;
                try {
                    Intent intent = params.createIntent();
                    startActivityForResult(intent, FILE_CHOOSER_RESULT_CODE);
                    return true;
                } catch (RuntimeException error) {
                    filePathCallback.onReceiveValue(null);
                    filePathCallback = null;
                    Toast.makeText(MainActivity.this, "تعذر فتح مدير الملفات على هذا الجهاز.", Toast.LENGTH_SHORT).show();
                    return true;
                }
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                final PermissionRequest pending = request;
                runOnUiThread(new Runnable() {
                    @Override public void run() { requestWebPermissions(pending); }
                });
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                final String requestedOrigin = origin;
                final GeolocationPermissions.Callback pending = callback;
                runOnUiThread(new Runnable() {
                    @Override public void run() { requestGeolocationPermission(requestedOrigin, pending); }
                });
            }
        });
        webView.addJavascriptInterface(new DownloadBridge(), "CodexaDownloads");
        webView.setDownloadListener(new android.webkit.DownloadListener() {
            @Override public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimeType, long contentLength) {
                handleDownload(url, userAgent, contentDisposition, mimeType);
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!"https".equalsIgnoreCase(uri.getScheme()) || !ASSET_HOST.equalsIgnoreCase(uri.getHost())) {
                    return allowExternalNetwork && ("https".equalsIgnoreCase(uri.getScheme()) || "wss".equalsIgnoreCase(uri.getScheme()))
                            ? super.shouldInterceptRequest(view, request) : notFound();
                }
                String encodedPath = uri.getEncodedPath();
                if (encodedPath == null || !encodedPath.startsWith("/assets/www/")) return notFound();
                String relative = Uri.decode(encodedPath.substring("/assets/www/".length()));
                if (relative.isEmpty() || relative.startsWith("/") || relative.contains("\\") || relative.indexOf('\0') >= 0) return notFound();
                for (String part : relative.split("/")) if (part.equals(".") || part.equals("..")) return notFound();
                try {
                    InputStream input = getAssets().open("www/" + relative);
                    String mime = mimeType(relative);
                    String encoding = mime.startsWith("text/") || mime.contains("javascript") || mime.contains("json") || mime.contains("xml") ? "UTF-8" : null;
                    Map<String, String> headers = new HashMap<>();
                    headers.put("X-Content-Type-Options", "nosniff");
                    headers.put("Cache-Control", "no-cache");
                    return new WebResourceResponse(mime, encoding, 200, "OK", headers, input);
                } catch (IOException error) {
                    return notFound();
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("https".equalsIgnoreCase(uri.getScheme()) && ASSET_HOST.equalsIgnoreCase(uri.getHost())) return false;
                String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
                if (scheme.equals("https") && allowExternalNetwork) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception ignored) { }
                } else if (scheme.equals("http")) {
                    Toast.makeText(MainActivity.this, "حُجب الرابط لأن HTTP غير المشفر غير مسموح.", Toast.LENGTH_SHORT).show();
                } else if (scheme.equals("https")) {
                    Toast.makeText(MainActivity.this, "حُجب الرابط الخارجي؛ فعّل إذن الشبكة عند إنشاء APK إذا كنت تثق بالمشروع.", Toast.LENGTH_SHORT).show();
                } else if (scheme.equals("mailto") || scheme.equals("tel")) {
                    Toast.makeText(MainActivity.this, "روابط البريد والاتصال الخارجي غير مدعومة داخل APK.", Toast.LENGTH_SHORT).show();
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (isAppOrigin(Uri.parse(url))) installDownloadCapture();
            }
        });
        setContentView(webView);
        webView.loadUrl("https://" + ASSET_HOST + "/assets/www/" + Uri.encode(readEntry(), "/"));
    }

    private String readEntry() {
        try (InputStream input = getAssets().open("codexa-entry.txt");
             BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            String value = reader.readLine();
            if (value != null && value.matches("[A-Za-z0-9_ .()\\-\\u0080-\\uFFFF/]+") && !value.startsWith("/") && !value.contains("..")) return value;
        } catch (IOException ignored) { }
        return "index.html";
    }

    private boolean readNetworkPermission() {
        try (InputStream input = getAssets().open("codexa-network.txt");
             BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            return "true".equalsIgnoreCase(reader.readLine());
        } catch (IOException ignored) { return false; }
    }

    private static final class PendingDownload {
        final byte[] bytes;
        final String mime;
        final String name;
        PendingDownload(byte[] bytes, String mime, String name) { this.bytes = bytes; this.mime = mime; this.name = name; }
    }

    private final class DownloadBridge {
        @JavascriptInterface
        public void saveDownload(String name, String mime, String base64) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (webView == null || !isAppOrigin(Uri.parse(webView.getUrl() == null ? "" : webView.getUrl()))) return;
                    if (base64 == null || base64.length() > 36 * 1024 * 1024) { Toast.makeText(MainActivity.this, "الملف أكبر من حد الحفظ (24 MiB).", Toast.LENGTH_LONG).show(); return; }
                    try {
                        byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                        if (bytes.length > 24 * 1024 * 1024) throw new IllegalArgumentException("file too large");
                        startDocumentSave(bytes, safeDownloadName(name), safeMime(mime));
                    } catch (RuntimeException error) { Toast.makeText(MainActivity.this, "تعذر تجهيز الملف للتنزيل.", Toast.LENGTH_SHORT).show(); }
                }
            });
        }
    }

    private static String safeDownloadName(String name) {
        String value = name == null ? "download" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (value.isEmpty() || value.equals(".") || value.equals("..")) return "download";
        return value.length() > 120 ? value.substring(0, 120) : value;
    }

    private static String safeMime(String mime) {
        return mime != null && mime.matches("[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+") ? mime.toLowerCase(Locale.ROOT) : "application/octet-stream";
    }

    private void startDocumentSave(byte[] bytes, String name, String mime) {
        if (pendingDownload != null) { Toast.makeText(this, "أكمل حفظ الملف الحالي أولاً.", Toast.LENGTH_SHORT).show(); return; }
        pendingDownload = new PendingDownload(bytes, mime, name);
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime);
        intent.putExtra(Intent.EXTRA_TITLE, name);
        try { startActivityForResult(intent, SAVE_DOWNLOAD_RESULT_CODE); }
        catch (RuntimeException error) { pendingDownload = null; Toast.makeText(this, "تعذر فتح نافذة حفظ الملفات.", Toast.LENGTH_LONG).show(); }
    }

    private void handleDownload(String url, String userAgent, String contentDisposition, String mimeType) {
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        String name = safeDownloadName(URLUtil.guessFileName(url, contentDisposition, mimeType));
        String mime = safeMime(mimeType);
        if (scheme.equals("data")) {
            try {
                int comma = url.indexOf(',');
                if (comma < 0) throw new IllegalArgumentException("bad data URL");
                String metadata = url.substring(5, comma);
                String encoded = url.substring(comma + 1);
                byte[] bytes = metadata.toLowerCase(Locale.ROOT).contains(";base64")
                        ? Base64.decode(encoded, Base64.DEFAULT)
                        : java.net.URLDecoder.decode(encoded, "UTF-8").getBytes(StandardCharsets.UTF_8);
                if (bytes.length > 24 * 1024 * 1024) throw new IllegalArgumentException("file too large");
                startDocumentSave(bytes, name, safeMime(metadata.split(";", 2)[0]));
            } catch (Exception error) { Toast.makeText(this, "تعذر تجهيز رابط data للتنزيل.", Toast.LENGTH_LONG).show(); }
            return;
        }
        if (scheme.equals("https") && ASSET_HOST.equalsIgnoreCase(uri.getHost())) {
            String encodedPath = uri.getEncodedPath() == null ? "" : uri.getEncodedPath();
            String relative = Uri.decode(encodedPath);
            if (!relative.startsWith("/assets/www/") || relative.contains("..") || relative.contains("\\")) { Toast.makeText(this, "مسار التنزيل المحلي غير صالح.", Toast.LENGTH_SHORT).show(); return; }
            try (InputStream input = getAssets().open(relative.substring("/assets/www/".length()));
                 java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream()) {
                byte[] chunk = new byte[8192]; int count;
                while ((count = input.read(chunk)) != -1) { if (buffer.size() + count > 24 * 1024 * 1024) throw new IOException("too large"); buffer.write(chunk, 0, count); }
                startDocumentSave(buffer.toByteArray(), name, mime);
            } catch (IOException error) { Toast.makeText(this, "تعذر قراءة الملف المحلي للتنزيل.", Toast.LENGTH_LONG).show(); }
            return;
        }
        if (!scheme.equals("https") || !allowExternalNetwork) { Toast.makeText(this, "التنزيل الخارجي محجوب؛ يلزم HTTPS وإذن الشبكة.", Toast.LENGTH_LONG).show(); return; }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            pendingRemoteDownload = new String[]{url, userAgent == null ? "" : userAgent, name, mime};
            requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, LEGACY_DOWNLOAD_PERMISSION_RESULT_CODE);
            return;
        }
        enqueueRemoteDownload(uri, userAgent, url, name, mime);
    }

    private void enqueueRemoteDownload(Uri uri, String userAgent, String url, String name, String mime) {
        try {
            DownloadManager.Request request = new DownloadManager.Request(uri)
                    .setTitle(name).setDescription("تنزيل من تطبيق CODEXA").setMimeType(mime)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            if (userAgent != null) request.addRequestHeader("User-Agent", userAgent);
            String cookie = android.webkit.CookieManager.getInstance().getCookie(url);
            if (cookie != null) request.addRequestHeader("Cookie", cookie);
            DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager == null) throw new IllegalStateException("DownloadManager unavailable");
            manager.enqueue(request);
            Toast.makeText(this, "بدأ التنزيل إلى مجلد التنزيلات.", Toast.LENGTH_SHORT).show();
        } catch (RuntimeException error) { Toast.makeText(this, "تعذر بدء التنزيل على هذا الجهاز.", Toast.LENGTH_LONG).show(); }
    }

    private void installDownloadCapture() {
        String script = "(function(){if(window.__codexaDownloadCapture)return;window.__codexaDownloadCapture=1;document.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a[download]'):null;if(!a)return;var u=a.href||'',n=a.download||'download';if(!/^blob:|^data:/i.test(u))return;e.preventDefault();fetch(u).then(function(r){var t=r.headers.get('content-type')||'application/octet-stream';return r.blob().then(function(b){var rd=new FileReader();rd.onload=function(){var s=String(rd.result).split(',')[1]||'';if(window.CodexaDownloads)CodexaDownloads.saveDownload(n,b.type||t,s);};rd.readAsDataURL(b);});}).catch(function(){alert('تعذر تجهيز الملف للتنزيل.');});},true);})();";
        webView.evaluateJavascript(script, null);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == SAVE_DOWNLOAD_RESULT_CODE) {
            PendingDownload download = pendingDownload;
            pendingDownload = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null && download != null) {
                try (OutputStream output = getContentResolver().openOutputStream(data.getData())) {
                    if (output == null) throw new IOException("No output stream");
                    output.write(download.bytes);
                    Toast.makeText(this, "تم حفظ الملف.", Toast.LENGTH_SHORT).show();
                } catch (IOException error) { Toast.makeText(this, "تعذر حفظ الملف المحدد.", Toast.LENGTH_LONG).show(); }
            }
            return;
        }
        if (requestCode != FILE_CHOOSER_RESULT_CODE || filePathCallback == null) return;
        Uri[] results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
        filePathCallback.onReceiveValue(results);
        filePathCallback = null;
    }

    private boolean isAppOrigin(Uri origin) {
        return origin != null && "https".equalsIgnoreCase(origin.getScheme())
                && ASSET_HOST.equalsIgnoreCase(origin.getHost());
    }

    private void requestWebPermissions(PermissionRequest request) {
        if (!isAppOrigin(request.getOrigin()) || pendingWebPermission != null) { request.deny(); return; }
        java.util.ArrayList<String> androidPermissions = new java.util.ArrayList<>();
        java.util.ArrayList<String> webResources = new java.util.ArrayList<>();
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                androidPermissions.add(Manifest.permission.CAMERA);
                webResources.add(resource);
            } else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                androidPermissions.add(Manifest.permission.RECORD_AUDIO);
                webResources.add(resource);
            }
        }
        if (webResources.isEmpty()) { request.deny(); return; }
        java.util.ArrayList<String> missing = new java.util.ArrayList<>();
        for (int i = 0; i < androidPermissions.size(); i++) {
            if (checkSelfPermission(androidPermissions.get(i)) != PackageManager.PERMISSION_GRANTED
                    && !missing.contains(androidPermissions.get(i))) missing.add(androidPermissions.get(i));
        }
        if (missing.isEmpty()) { request.grant(webResources.toArray(new String[0])); return; }
        pendingWebPermission = request;
        pendingWebResources = webResources.toArray(new String[0]);
        requestPermissions(missing.toArray(new String[0]), WEB_PERMISSION_RESULT_CODE);
    }

    private void requestGeolocationPermission(String origin, GeolocationPermissions.Callback callback) {
        if (!isAppOrigin(Uri.parse(origin)) || pendingGeolocationCallback != null) {
            callback.invoke(origin, false, false);
            return;
        }
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
            callback.invoke(origin, true, false);
            return;
        }
        pendingGeolocationOrigin = origin;
        pendingGeolocationCallback = callback;
        requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, GEOLOCATION_RESULT_CODE);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == WEB_PERMISSION_RESULT_CODE) {
            PermissionRequest request = pendingWebPermission;
            String[] resources = pendingWebResources;
            pendingWebPermission = null;
            pendingWebResources = null;
            if (request == null) return;
            java.util.ArrayList<String> granted = new java.util.ArrayList<>();
            for (String resource : resources) {
                String needed = PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)
                        ? Manifest.permission.CAMERA : Manifest.permission.RECORD_AUDIO;
                if (checkSelfPermission(needed) == PackageManager.PERMISSION_GRANTED) granted.add(resource);
            }
            if (granted.isEmpty()) request.deny();
            else request.grant(granted.toArray(new String[0]));
        } else if (requestCode == GEOLOCATION_RESULT_CODE) {
            GeolocationPermissions.Callback callback = pendingGeolocationCallback;
            String origin = pendingGeolocationOrigin;
            pendingGeolocationCallback = null;
            pendingGeolocationOrigin = null;
            if (callback != null) {
                boolean granted = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                        || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
                callback.invoke(origin, granted, false);
            }
        } else if (requestCode == LEGACY_DOWNLOAD_PERMISSION_RESULT_CODE) {
            String[] pending = pendingRemoteDownload;
            pendingRemoteDownload = null;
            if (pending == null || checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                Toast.makeText(this, "لم يُسمح للتطبيق بحفظ التنزيل في مجلد Downloads.", Toast.LENGTH_LONG).show();
                return;
            }
            enqueueRemoteDownload(Uri.parse(pending[0]), pending[1], pending[0], pending[2], pending[3]);
        }
    }

    private static String mimeType(String fileName) {
        String extension = MimeTypeMap.getFileExtensionFromUrl(fileName).toLowerCase(Locale.ROOT);
        String type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
        if (type != null) return type;
        if (extension.equals("js") || extension.equals("mjs")) return "text/javascript";
        if (extension.equals("json") || extension.equals("map")) return "application/json";
        if (extension.equals("wasm")) return "application/wasm";
        if (extension.equals("webmanifest")) return "application/manifest+json";
        if (extension.equals("woff2")) return "font/woff2";
        if (extension.equals("woff")) return "font/woff";
        if (extension.equals("svg")) return "image/svg+xml";
        return "application/octet-stream";
    }

    private static WebResourceResponse notFound() {
        Map<String, String> headers = Collections.singletonMap("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", headers,
                new ByteArrayInputStream("Asset not found".getBytes(StandardCharsets.UTF_8)));
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (filePathCallback != null) { filePathCallback.onReceiveValue(null); filePathCallback = null; }
        if (pendingWebPermission != null) { pendingWebPermission.deny(); pendingWebPermission = null; }
        if (pendingGeolocationCallback != null) { pendingGeolocationCallback.invoke(pendingGeolocationOrigin, false, false); pendingGeolocationCallback = null; }
        if (webView != null) { webView.stopLoading(); webView.destroy(); webView = null; }
        super.onDestroy();
    }
}
