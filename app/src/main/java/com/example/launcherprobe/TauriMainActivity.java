package com.example.launcherprobe;

import android.os.Bundle;
import android.os.Process;
import android.view.View;
import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

/**
 * M18 Tauri 界面入口：独立 {@code :tauri_ui} 进程，SDK 退出只结束本进程，
 * 默认进程的 Host/FGS/旧能力不受影响。
 */
public class TauriMainActivity extends TauriActivity {
    static {
        // :tauri_ui 必须在本进程首个 WebView 创建前设置独立数据目录，避免多进程 WebView 冲突；
        // 旧 Capacitor 进程（MainActivity）不设置，保留原 WebView 目录与 localStorage。
        WebView.setDataDirectorySuffix("tauri-ui");
    }

    private volatile boolean resumed;
    private View insetsTarget;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 沿用既有外观偏好决定状态/导航栏图标明暗；只改系统栏，不换主题、不重建 Activity。
        AppAppearance appearance = AppAppearance.read(this);
        appearance.applySystemBars(this, appearance.surface);
        // edge-to-edge 下系统栏区域显示窗口底色，跟随机身外观偏好，避免白图标压白底。
        getWindow().getDecorView().setBackgroundColor(appearance.surface);
    }

    /**
     * targetSdk 36 强制 edge-to-edge：内容容器按真实 systemBars/displayCutout + IME 让位。
     * wry 0.57 的顺序是 setWebView→onWebViewCreate（main_pipe.rs:239-244）之后才 setContentView
     * （317-322），且 AppCompat 可能替换 android.R.id.content，所以必须在 WebView 真正 attach
     * 之后才绑定容器；绑到旧的初始内容容器会直接失效。
     */
    private void applyContentInsets() {
        View content = getWindow().getDecorView().findViewById(android.R.id.content);
        if (content == null || content == insetsTarget) return;
        insetsTarget = content;
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        ViewCompat.setOnApplyWindowInsetsListener(content, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            // 键盘与系统导航栏重叠时取较大者，底部只留一次；绝对赋值，重复分发不累积。
            view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            return windowInsets;
        });
        ViewCompat.requestApplyInsets(content);
    }

    @Override public void onWebViewCreate(WebView webView) {
        super.onWebViewCreate(webView);
        // 仅 debug 构建开启 WebView 检查；release 保持 false，不放松 CSP/Origin/TLS。
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        // 此回调早于 Rust 的 setContentView（见上），post 到当前调用栈之后再绑定真实内容容器。
        webView.post(this::applyContentInsets);
    }

    @Override protected void onResume() {
        super.onResume();
        resumed = true;
    }

    @Override protected void onPause() {
        resumed = false;
        super.onPause();
    }

    @Override protected void onDestroy() {
        resumed = false;
        super.onDestroy();
        // SDK 清理完成后只终止隔离 UI 进程，避免 C 全局析构与绘图线程冲突。
        if (!isChangingConfigurations()) {
            Process.killProcess(Process.myPid());
        }
    }

    /** 插件原生前台校验：真实 resumed 且未结束/销毁。 */
    public boolean isUiResumed() {
        return resumed && !isFinishing() && !isDestroyed();
    }
}
