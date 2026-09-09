package com.example.launcherprobe;

import android.app.Activity;
import android.app.role.RoleManager;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.text.Collator;
import java.util.List;

public class MainActivity extends Activity {
    private TextView state;
    private TextView gestureState;
    private final Runnable refreshGestures = () -> gestureState.setText(GestureService.status(this));
    private RoleManager roles;
    private int resumeCount;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        roles = getSystemService(RoleManager.class);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        int padding = (int) (16 * getResources().getDisplayMetrics().density);
        ScrollView scroll = new ScrollView(this);
        scroll.addView(content);
        // targetSdk 35 强制 edge-to-edge；为状态栏和导航栏留出触摸空间。
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(padding + insets.getSystemWindowInsetLeft(),
                    padding + insets.getSystemWindowInsetTop(),
                    padding + insets.getSystemWindowInsetRight(),
                    padding + insets.getSystemWindowInsetBottom());
            return insets;
        });
        setContentView(scroll);
        text(content, "Launcher Probe — 桌面技术验证", 24);
        text(content, Build.MANUFACTURER + " " + Build.MODEL
                + "\nAndroid " + Build.VERSION.RELEASE + " / SDK " + Build.VERSION.SDK_INT
                + "\n系统构建：" + Build.DISPLAY, 16);
        state = text(content, "", 16);
        button(content, "请求成为默认桌面", view -> requestHome());
        button(content, "打开默认桌面设置 / 恢复系统桌面",
                view -> launch(new Intent(Settings.ACTION_HOME_SETTINGS)));
        button(content, "打开系统设置（测试返回与最近任务）",
                view -> launch(new Intent(Settings.ACTION_SETTINGS)));
        text(content, "Ogesture 手势（AGPL-3.0 源码适配）", 20);
        gestureState = text(content, "", 16);
        text(content, "先在系统设置开启无障碍服务，再通过电脑 ADB 一次性授权：\n"
                + GestureService.GRANT_COMMAND, 14).setTextIsSelectable(true);
        button(content, "打开无障碍授权设置",
                view -> launch(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        button(content, "启用手势并隐藏三键", view -> GestureService.enable(this));
        button(content, "停用手势并恢复三键", view -> GestureService.disable(this));
        text(content, "左右内滑返回；底边上滑松手回桌面，停留 300ms 打开最近任务。"
                + "离开此页面仍运行。强行停止、系统杀进程或卸载不能保证恢复三键；"
                + "请先停用并确认三键显示。启用会改变 HyperOS 导航设置，不读取窗口内容。", 16);

        PackageManager pm = getPackageManager();
        Intent query = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> apps = pm.queryIntentActivities(query, 0);
        Collator collator = Collator.getInstance();
        apps.sort((left, right) -> collator.compare(
                left.loadLabel(pm).toString(), right.loadLabel(pm).toString()));
        text(content, "可启动入口（当前用户）：" + apps.size(), 18);
        for (ResolveInfo app : apps) {
            ComponentName component = new ComponentName(
                    app.activityInfo.packageName, app.activityInfo.name);
            button(content, "启动：" + app.loadLabel(pm) + "\n" + component.getPackageName(),
                    view -> launch(new Intent(Intent.ACTION_MAIN)
                            .addCategory(Intent.CATEGORY_LAUNCHER)
                            .setComponent(component)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                                    | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)));
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        resumeCount++;
        GestureService.statusListener = refreshGestures;
        GestureService.recover(this);
        state.setText("默认 HOME 角色："
                + (roles != null && roles.isRoleHeld(RoleManager.ROLE_HOME) ? "已持有" : "未持有")
                + "\n本 Activity 实例 onResume 次数：" + resumeCount);
    }

    @Override
    protected void onPause() {
        if (GestureService.statusListener == refreshGestures) GestureService.statusListener = null;
        super.onPause();
    }

    private void requestHome() {
        if (roles == null || !roles.isRoleAvailable(RoleManager.ROLE_HOME)) {
            failure("系统未提供 HOME 角色请求，请使用默认桌面设置入口。");
            return;
        }
        if (roles.isRoleHeld(RoleManager.ROLE_HOME)) {
            failure("已经是默认桌面。");
            return;
        }
        launch(roles.createRequestRoleIntent(RoleManager.ROLE_HOME));
    }

    private void launch(Intent intent) {
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException | SecurityException exception) {
            failure("无法打开：" + exception.getClass().getSimpleName()
                    + "\n请从系统设置手动操作；应用也可能已被卸载或禁用。");
        }
    }

    private void failure(String message) {
        state.setText(message);
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
    }

    private TextView text(LinearLayout parent, String value, int size) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        parent.addView(view);
        return view;
    }

    private void button(LinearLayout parent, String label, View.OnClickListener listener) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setOnClickListener(listener);
        parent.addView(button);
    }
}
