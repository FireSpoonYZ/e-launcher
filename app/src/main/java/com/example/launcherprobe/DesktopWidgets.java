package com.example.launcherprobe;

import android.app.Activity;
import android.app.AlertDialog;
import android.appwidget.AppWidgetHost;
import android.appwidget.AppWidgetHostView;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProviderInfo;
import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.widget.Toast;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/** The system owns binding consent and provider configuration, including restored widgets. */
final class DesktopWidgets {
    static final int HOST_ID = 1024;
    private static final int BIND = 8101, CONFIGURE = 8102;
    private final Activity activity;
    private final HomeLayout layout;
    private final Runnable changed;
    private final AppWidgetHost host;
    private final AppWidgetManager manager;
    private final SharedPreferences pending;

    DesktopWidgets(Activity activity, HomeLayout layout, Runnable changed) {
        this.activity = activity; this.layout = layout; this.changed = changed;
        host = new AppWidgetHost(activity, HOST_ID);
        manager = AppWidgetManager.getInstance(activity);
        pending = activity.getSharedPreferences("desktop_widget_pending", Activity.MODE_PRIVATE);
    }
    void start() {
        try { host.startListening(); } catch (RuntimeException e) { error(e); }
    }
    void stop() {
        try { host.stopListening(); } catch (RuntimeException e) { android.util.Log.w("DesktopWidgets", "Could not stop listening", e); }
    }
    boolean remove(HomeLayout.Item item) {
        try {
            if (HomeLayout.Item.APPWIDGET.equals(item.type) && item.appWidgetId >= 0) host.deleteAppWidgetId(item.appWidgetId);
            return true;
        } catch (RuntimeException e) { error(e); return false; }
    }
    void choose() {
        if (pending.contains("id")) { message("请先完成当前小组件添加"); return; }
        List<AppWidgetProviderInfo> providers = new ArrayList<>(manager.getInstalledProviders());
        providers.sort(Comparator.comparing(p -> p.loadLabel(activity.getPackageManager())));
        String[] labels = new String[providers.size()];
        for (int i = 0; i < providers.size(); i++) labels[i] = providers.get(i).loadLabel(activity.getPackageManager());
        new AlertDialog.Builder(activity).setTitle("添加系统小组件")
                .setItems(labels, (dialog, which) -> bind(providers.get(which), -1))
                .setMessage(providers.isEmpty() ? "没有可用的小组件提供方，请先安装支持小组件的应用。" : null)
                .setNegativeButton("取消", null).show();
    }
    void rebind(int slot) {
        HomeLayout.Item item = layout.get(slot);
        ComponentName provider = item.provider == null ? null : ComponentName.unflattenFromString(item.provider);
        for (AppWidgetProviderInfo info : manager.getInstalledProviders()) if (info.provider.equals(provider)) {
            bind(info, slot); return;
        }
        message("小组件提供方尚未安装或暂不可用；布局已保留");
    }
    private void bind(AppWidgetProviderInfo info, int slot) {
        if (pending.contains("id")) { message("请先完成当前小组件添加"); return; }
        int id;
        try { id = host.allocateAppWidgetId(); }
        catch (RuntimeException e) { error(e); return; }
        if (!pending.edit().putInt("id", id).putInt("slot", slot)
                .putString("provider", info.provider.flattenToString()).commit()) {
            host.deleteAppWidgetId(id); message("无法保存小组件绑定请求"); return;
        }
        try {
            if (manager.bindAppWidgetIdIfAllowed(id, info.provider)) configure(id);
            else activity.startActivityForResult(new Intent(AppWidgetManager.ACTION_APPWIDGET_BIND)
                    .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
                    .putExtra(AppWidgetManager.EXTRA_APPWIDGET_PROVIDER, info.provider), BIND);
        } catch (RuntimeException e) { cancel(); error(e); }
    }
    boolean result(int request, int result) {
        if (request != BIND && request != CONFIGURE) return false;
        int id = pending.getInt("id", -1);
        if (id < 0) return true;
        if (result != Activity.RESULT_OK) { cancel(); return true; }
        try { if (request == BIND) configure(id); else finish(id); }
        catch (RuntimeException e) { cancel(); error(e); }
        return true;
    }
    private void configure(int id) {
        AppWidgetProviderInfo info = manager.getAppWidgetInfo(id);
        if (info == null) { cancel(); message("系统未授权绑定小组件"); return; }
        try {
            if (info.configure == null) finish(id);
            else host.startAppWidgetConfigureActivityForResult(activity, id, 0, CONFIGURE, null);
        } catch (RuntimeException e) { cancel(); error(e); }
    }
    private void finish(int id) {
        AppWidgetProviderInfo info = manager.getAppWidgetInfo(id);
        if (info == null) { cancel(); return; }
        int slot = pending.getInt("slot", -1);
        HomeLayout.Item previous = slot >= 0 && slot < layout.size() ? layout.get(slot) : null;
        if (previous != null && !HomeLayout.Item.APPWIDGET.equals(previous.type)) { cancel(); return; }
        float density = activity.getResources().getDisplayMetrics().density;
        int cellWidth = Math.max(1, activity.getResources().getDisplayMetrics().widthPixels / layout.columns);
        int x = Math.max(1, Math.min(layout.columns, (info.minWidth + cellWidth - 1) / cellWidth));
        int y = Math.max(1, Math.min(layout.rows, (int) Math.ceil(info.minHeight / (80 * density))));
        if (previous != null) {
            x = previous.spanX; y = previous.spanY;
            if (!remove(previous)) { cancel(); return; }
        }
        else {
            for (int i = 0; i < layout.size(); i++) {
                HomeLayout.Item candidate = layout.get(i);
                if (candidate != null && HomeLayout.Item.WIDGET_PICKER.equals(candidate.type)
                        && layout.fits(i, x, y, i)) { slot = i; break; }
            }
            if (slot < 0) slot = layout.vacancy(x, y);
        }
        layout.set(slot, HomeLayout.Item.widget(HomeLayout.Item.APPWIDGET, x, y, id, info.provider.flattenToString()));
        pending.edit().clear().commit();
        changed.run();
    }
    AppWidgetHostView view(HomeLayout.Item item) {
        AppWidgetProviderInfo info = manager.getAppWidgetInfo(item.appWidgetId);
        if (info == null) return null;
        AppWidgetHostView view = host.createView(activity, item.appWidgetId, info);
        view.setPadding(0, 0, 0, 0);
        view.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> {
            if (r - l == or - ol && b - t == ob - ot) return;
            float density = activity.getResources().getDisplayMetrics().density;
            int width = Math.max(1, (int) ((r - l) / density));
            int height = Math.max(1, (int) ((b - t) / density));
            view.updateAppWidgetSize(new Bundle(), width, height, width, height);
        });
        return view;
    }
    boolean canResize(HomeLayout.Item item, int x, int y, int cellWidth, int cellHeight) {
        if (!HomeLayout.Item.APPWIDGET.equals(item.type)) return true;
        AppWidgetProviderInfo info = manager.getAppWidgetInfo(item.appWidgetId);
        if (info == null) return true;
        if (x != item.spanX && (info.resizeMode & AppWidgetProviderInfo.RESIZE_HORIZONTAL) == 0) return false;
        if (y != item.spanY && (info.resizeMode & AppWidgetProviderInfo.RESIZE_VERTICAL) == 0) return false;
        return x * cellWidth >= Math.min(info.minWidth, info.minResizeWidth > 0 ? info.minResizeWidth : info.minWidth)
                && y * cellHeight >= Math.min(info.minHeight, info.minResizeHeight > 0 ? info.minResizeHeight : info.minHeight)
                && (android.os.Build.VERSION.SDK_INT < 31 || ((info.maxResizeWidth <= 0 || x * cellWidth <= info.maxResizeWidth)
                && (info.maxResizeHeight <= 0 || y * cellHeight <= info.maxResizeHeight)));
    }
    private void cancel() {
        int id = pending.getInt("id", -1);
        try { if (id >= 0) host.deleteAppWidgetId(id); }
        catch (RuntimeException e) { android.util.Log.w("DesktopWidgets", "Could not release canceled widget", e); }
        pending.edit().clear().commit();
    }
    private void error(RuntimeException e) { message("小组件操作失败：" + e.getClass().getSimpleName()); }
    private void message(String text) { Toast.makeText(activity, text, Toast.LENGTH_LONG).show(); }
}
