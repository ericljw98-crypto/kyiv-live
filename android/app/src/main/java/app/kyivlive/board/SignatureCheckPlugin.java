package app.kyivlive.board;

import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.security.MessageDigest;
import java.util.Locale;

/**
 * 读取本包的签名证书并与发布时固定的期望指纹比对，供 WebView 层展示校验结果。
 * 期望值必须与 signing/fingerprint.sha256 保持一致；发布前的 apksigner 闸门
 * 会在服务端做同一件事，两处不一致说明发布流程出了问题。
 */
@CapacitorPlugin(name = "SignatureCheck")
public class SignatureCheckPlugin extends Plugin {

    private static final String EXPECTED =
            "c5e94cb12c25e4c3cf833549422f63baece997a582d59ac7ed2d7fe6463de8ed";

    @PluginMethod
    public void verify(PluginCall call) {
        try {
            String packageName = getContext().getPackageName();
            PackageManager pm = getContext().getPackageManager();
            Signature[] signers;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                PackageInfo info = pm.getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES);
                SigningInfo signingInfo = info.signingInfo;
                signers = signingInfo == null ? null : signingInfo.getApkContentsSigners();
            } else {
                @SuppressWarnings("deprecation")
                PackageInfo info = pm.getPackageInfo(packageName, PackageManager.GET_SIGNATURES);
                signers = info.signatures;
            }
            if (signers == null || signers.length == 0) {
                call.reject("未读取到安装包签名证书");
                return;
            }
            String actual = sha256(signers[0].toByteArray());
            JSObject result = new JSObject();
            result.put("ok", EXPECTED.equalsIgnoreCase(actual));
            result.put("expected", EXPECTED);
            result.put("actual", actual);
            result.put("packageName", packageName);
            result.put("multipleSigners", signers.length > 1);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("签名校验失败：" + error.getMessage());
        }
    }

    private static String sha256(byte[] data) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(data);
        StringBuilder hex = new StringBuilder();
        for (byte b : digest) {
            hex.append(String.format(Locale.US, "%02x", b & 0xff));
        }
        return hex.toString();
    }
}
