package app.kyivlive.board;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 应用内更新插件：在 App 内部把新 APK 下载到私有缓存目录，边下边算 SHA-256，
 * 校验通过后再通过 FileProvider 授予 URI 权限并拉起系统安装器。
 *
 * 说明：
 * - Android 不允许非系统签名应用静默安装，最后一步必然弹出系统确认框，这是平台限制。
 * - 下载在后台线程执行，进度通过 downloadProgress 事件回传；resolve/reject 由 Capacitor
 *   内部切回主线程，插件方法本身可安全从后台调用。
 */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {

    private static final String TAG = "AppUpdater";
    private static final String EVENT_PROGRESS = "downloadProgress";
    private static final String APK_NAME = "kyiv-live-update.apk";

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean canceled = new AtomicBoolean(false);

    /** 是否有下载任务在进行 */
    private volatile boolean downloading = false;

    /**
     * 应用内下载 APK。
     * 参数：url（下载地址）、sha256（期望的 64 位十六进制摘要，可选）、name（可选）。
     * 若目标文件已存在且 sha256 匹配，直接复用，不重复下载。
     */
    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.trim().isEmpty()) {
            call.reject("下载地址为空");
            return;
        }
        String expectedSha = call.getString("sha256");
        if (expectedSha != null) expectedSha = expectedSha.trim().toLowerCase(Locale.US);

        if (downloading) {
            call.reject("已有下载任务在进行");
            return;
        }
        downloading = true;
        canceled.set(false);

        final String finalUrl = url.trim();
        final String finalSha = expectedSha;
        executor.execute(() -> doDownload(call, finalUrl, finalSha));
    }

    private void doDownload(PluginCall call, String url, String expectedSha) {
        HttpURLConnection conn = null;
        InputStream in = null;
        FileOutputStream out = null;
        File apk = null;
        File tmp = null;
        try {
            Context ctx = getContext();
            File dir = new File(ctx.getCacheDir(), "updates");
            if (!dir.exists()) dir.mkdirs();
            apk = new File(dir, APK_NAME);
            tmp = new File(dir, APK_NAME + ".part");

            // 已下载且校验通过则直接复用（重复点击/中断后续传场景）。
            if (apk.exists() && apk.length() > 0 && expectedSha != null && expectedSha.length() == 64) {
                String existing = sha256Of(apk);
                if (expectedSha.equalsIgnoreCase(existing)) {
                    JSObject res = new JSObject();
                    res.put("path", apk.getAbsolutePath());
                    res.put("sha256", existing);
                    res.put("size", apk.length());
                    res.put("reused", true);
                    downloading = false;
                    call.resolve(res);
                    return;
                }
            }

            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(30000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent", "KyivLive/AppUpdater");
            conn.connect();
            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                throw new java.io.IOException("HTTP " + code);
            }

            long total = conn.getContentLengthLong();
            in = conn.getInputStream();
            out = new FileOutputStream(tmp, false);

            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[16 * 1024];
            long loaded = 0;
            int read;
            int lastPercent = -1;
            while ((read = in.read(buf)) != -1) {
                if (canceled.get()) {
                    closeQuietly(out);
                    closeQuietly(in);
                    if (tmp.exists()) tmp.delete();
                    downloading = false;
                    call.reject("下载已取消");
                    return;
                }
                out.write(buf, 0, read);
                digest.update(buf, 0, read);
                loaded += read;
                int percent = total > 0 ? (int) (loaded * 100 / total) : -1;
                if (percent != lastPercent && percent >= 0) {
                    lastPercent = percent;
                    JSObject p = new JSObject();
                    p.put("percent", percent);
                    p.put("loaded", loaded);
                    p.put("total", total);
                    notifyListeners(EVENT_PROGRESS, p);
                }
            }
            out.flush();
            closeQuietly(out);
            out = null;
            closeQuietly(in);
            in = null;

            String actual = hex(digest.digest());
            if (expectedSha != null && expectedSha.length() == 64 && !expectedSha.equalsIgnoreCase(actual)) {
                if (tmp.exists()) tmp.delete();
                downloading = false;
                JSObject err = new JSObject();
                err.put("code", "SHA256_MISMATCH");
                call.reject("下载校验失败：文件摘要与官方值不一致，已丢弃", err);
                return;
            }

            if (apk.exists()) apk.delete();
            if (!tmp.renameTo(apk)) {
                downloading = false;
                call.reject("安装包保存失败");
                return;
            }

            JSObject res = new JSObject();
            res.put("path", apk.getAbsolutePath());
            res.put("sha256", actual);
            res.put("size", apk.length());
            res.put("reused", false);
            downloading = false;
            call.resolve(res);
        } catch (Exception e) {
            if (tmp != null && tmp.exists()) tmp.delete();
            downloading = false;
            String msg = e.getMessage() == null ? e.toString() : e.getMessage();
            call.reject("下载失败：" + msg);
        } finally {
            closeQuietly(out);
            closeQuietly(in);
            if (conn != null) conn.disconnect();
        }
    }

    /** 取消当前下载（下一写入周期生效） */
    @PluginMethod
    public void cancel(PluginCall call) {
        canceled.set(true);
        JSObject res = new JSObject();
        res.put("ok", true);
        call.resolve(res);
    }

    /** 查询系统是否允许本应用安装未知来源 APK（Android 8+） */
    @PluginMethod
    public void canInstall(PluginCall call) {
        boolean allowed = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            allowed = getContext().getPackageManager().canRequestPackageInstalls();
        }
        JSObject res = new JSObject();
        res.put("allowed", allowed);
        call.resolve(res);
    }

    /** 跳转到「允许安装未知应用」的系统设置页 */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
                intent.setData(Uri.parse("package:" + getContext().getPackageName()));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
                call.resolve();
            } catch (Exception e) {
                call.reject("无法打开安装权限设置：" + (e.getMessage() == null ? e.toString() : e.getMessage()));
            }
        } else {
            call.resolve();
        }
    }

    /** 拉起系统安装器安装已下载的 APK */
    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.trim().isEmpty()) {
            call.reject("安装包路径为空");
            return;
        }
        File apk = new File(path.trim());
        if (!apk.exists() || apk.length() == 0) {
            call.reject("安装包不存在或为空，请重新下载");
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getContext().getPackageManager().canRequestPackageInstalls()) {
            JSObject err = new JSObject();
            err.put("code", "PERMISSION_NEEDED");
            call.reject("需要「安装未知应用」权限", err);
            return;
        }
        try {
            Uri uri;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
            } else {
                uri = Uri.fromFile(apk);
            }
            Intent intent = new Intent(Intent.ACTION_INSTALL_PACKAGE);
            intent.setData(uri);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                intent.putExtra(Intent.EXTRA_NOT_UNKNOWN_SOURCE, true);
            }
            getContext().startActivity(intent);
            JSObject res = new JSObject();
            res.put("ok", true);
            call.resolve(res);
        } catch (Exception e) {
            call.reject("无法拉起安装器：" + (e.getMessage() == null ? e.toString() : e.getMessage()));
        }
    }

    /** 删除已缓存的安装包 */
    @PluginMethod
    public void clear(PluginCall call) {
        try {
            File dir = new File(getContext().getCacheDir(), "updates");
            File apk = new File(dir, APK_NAME);
            File tmp = new File(dir, APK_NAME + ".part");
            if (apk.exists()) apk.delete();
            if (tmp.exists()) tmp.delete();
            call.resolve();
        } catch (Exception e) {
            call.reject("清理失败");
        }
    }

    private static String sha256Of(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new java.io.FileInputStream(file)) {
            byte[] buf = new byte[16 * 1024];
            int read;
            while ((read = in.read(buf)) != -1) digest.update(buf, 0, read);
        }
        return hex(digest.digest());
    }

    private static String hex(byte[] data) {
        StringBuilder sb = new StringBuilder();
        for (byte b : data) sb.append(String.format(Locale.US, "%02x", b & 0xff));
        return sb.toString();
    }

    private static void closeQuietly(java.io.Closeable c) {
        if (c == null) return;
        try { c.close(); } catch (Exception ignored) { }
    }
}
