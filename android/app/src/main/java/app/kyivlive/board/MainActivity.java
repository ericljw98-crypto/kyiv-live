package app.kyivlive.board;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // 必须在 super.onCreate 之前：BridgeActivity 在 super.onCreate 内就会创建 Bridge，
        // 之后再注册的插件不会进入本次运行的插件列表。
        registerPlugin(SignatureCheckPlugin.class);
        registerPlugin(AppUpdaterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
