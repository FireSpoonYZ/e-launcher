package com.example.launcherprobe;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.UriPermission;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.pm.ShortcutInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.Process;
import android.os.OperationCanceledException;
import android.os.UserManager;
import android.provider.DocumentsContract;
import android.provider.Settings;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Device-backed search. Construct and query off the UI thread. No file content is read. */
final class LauncherSearchIndex {
    record App(ResolveInfo info, ComponentName component, String label, SearchName name,
            SearchName aliases, long installed, long launched, long userSerial) {
        boolean matches(String query) {
            return AppSearch.matches(label, component.getPackageName(), query)
                    || name.matches(query) || aliases.matches(query);
        }
    }
    record Shortcut(ShortcutInfo info, String label) { }
    record Setting(String label, String destination, Intent intent) { }
    record FileResult(String name, Uri uri, String mime) { }
    record Result(List<App> apps, List<Shortcut> shortcuts, List<Setting> settings,
            List<FileResult> files, String shortcutNotice, String fileNotice) { }

    final List<App> apps;
    private final Context context;
    private final LauncherShortcuts shortcuts;

    LauncherSearchIndex(Context context, CancellationSignal cancellation) {
        this.context = context.getApplicationContext();
        shortcuts = new LauncherShortcuts(context);
        PackageManager pm = context.getPackageManager();
        long serial = context.getSystemService(UserManager.class).getSerialNumberForUser(Process.myUserHandle());
        List<App> found = new ArrayList<>();
        Set<ComponentName> seen = new HashSet<>();
        for (ResolveInfo info : pm.queryIntentActivities(new Intent(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER), 0)) {
            cancellation.throwIfCanceled();
            ComponentName component = new ComponentName(info.activityInfo.packageName, info.activityInfo.name);
            if (!seen.add(component)) continue;
            String label = info.loadLabel(pm).toString();
            long installed = 0;
            try { installed = pm.getPackageInfo(component.getPackageName(), 0).firstInstallTime; }
            catch (PackageManager.NameNotFoundException ignored) { continue; }
            String aliases = defaultAliases(component.getPackageName()) + " " + context
                    .getSharedPreferences("launcher_search", Context.MODE_PRIVATE)
                    .getString("alias:" + component.flattenToString(), "");
            found.add(new App(info, component, label, new SearchName(label), new SearchName(aliases),
                    installed, AppLaunchHistory.lastLaunch(context, component), serial));
        }
        found.sort(Comparator.comparing((App app) -> app.name.section().equals("#") ? "~" : app.name.section())
                .thenComparing(app -> app.name.sortKey).thenComparing(app -> app.component.flattenToString()));
        apps = List.copyOf(found);
    }

    Result search(String query, boolean global, CancellationSignal cancellation,
            java.util.function.Consumer<Result> localResults) {
        List<App> matches = new ArrayList<>();
        for (App app : apps) {
            cancellation.throwIfCanceled();
            if (app.matches(query)) matches.add(app);
        }
        if (!global || query.trim().isEmpty())
            return new Result(matches, List.of(), List.of(), List.of(), "", "");
        DesktopPreferences preferences = new DesktopPreferences(context);
        List<Shortcut> shortcutResults = new ArrayList<>();
        String shortcutNotice = "";
        try {
            if (!preferences.searchShortcuts()) shortcutNotice = "已在桌面设置中关闭快捷方式搜索";
            else if (!shortcuts.hasAccess()) shortcutNotice = "设为默认桌面后可搜索应用快捷方式";
            else for (ShortcutInfo shortcut : shortcuts.searchAll()) {
                cancellation.throwIfCanceled();
                if (!shortcut.isEnabled()) continue;
                String label = String.valueOf(shortcut.getShortLabel());
                if (new SearchName(label).matches(query)) shortcutResults.add(new Shortcut(shortcut, label));
            }
        } catch (SecurityException | IllegalStateException failure) {
            shortcutNotice = "快捷方式暂不可访问，请检查默认桌面授权";
        }
        List<Setting> settings = settings(query, matches);
        if (!preferences.searchFiles()) return new Result(matches, shortcutResults, settings, List.of(),
                shortcutNotice, "已在桌面设置中关闭文件名称搜索");
        localResults.accept(new Result(matches, shortcutResults, settings, List.of(), shortcutNotice,
                "正在搜索已授权目录的文件名…"));
        List<FileResult> files = new ArrayList<>();
        String fileNotice = findFiles(query, files, cancellation);
        return new Result(matches, shortcutResults, settings, files, shortcutNotice, fileNotice);
    }

    private List<Setting> settings(String query, List<App> matchingApps) {
        List<Setting> result = new ArrayList<>();
        String[][] desktop = {{"桌面设置", "desktop"}, {"网格与图标文字大小", "grid"},
                {"锁定布局", "layout"}, {"Dock 栏", "dock"}, {"搜索与别名", "search"},
                {"文件夹", "folders"}, {"小组件", "widgets"}, {"手势", "gestures"},
                {"壁纸", "wallpaper"}, {"图标包", "icons"}, {"浅色深色主题", "theme"},
                {"备份与恢复", "backup"}, {"助手设置 模型工具与扩展", "assistant"}};
        for (String[] entry : desktop) if (new SearchName(entry[0]).matches(query))
            result.add(new Setting(entry[0], entry[1], null));
        String[][] system = {{"系统设置", Settings.ACTION_SETTINGS}, {"无线网络 WiFi", Settings.ACTION_WIFI_SETTINGS},
                {"蓝牙", Settings.ACTION_BLUETOOTH_SETTINGS}, {"应用管理", Settings.ACTION_APPLICATION_SETTINGS},
                {"通知", Settings.ACTION_ALL_APPS_NOTIFICATION_SETTINGS}, {"显示与亮度", Settings.ACTION_DISPLAY_SETTINGS},
                {"声音", Settings.ACTION_SOUND_SETTINGS}, {"存储", Settings.ACTION_INTERNAL_STORAGE_SETTINGS},
                {"电池", Settings.ACTION_BATTERY_SAVER_SETTINGS}, {"默认桌面", Settings.ACTION_HOME_SETTINGS},
                {"无障碍", Settings.ACTION_ACCESSIBILITY_SETTINGS}, {"日期与时间", Settings.ACTION_DATE_SETTINGS}};
        for (String[] entry : system) {
            Intent intent = new Intent(entry[1]);
            if (new SearchName(entry[0]).matches(query) && intent.resolveActivity(context.getPackageManager()) != null)
                result.add(new Setting(entry[0], null, intent));
        }
        for (App app : matchingApps) {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + app.component.getPackageName()));
            if (intent.resolveActivity(context.getPackageManager()) != null)
                result.add(new Setting("应用管理 · " + app.label, null, intent));
        }
        return result;
    }

    private String findFiles(String query, List<FileResult> result, CancellationSignal cancellation) {
        List<UriPermission> permissions = context.getContentResolver().getPersistedUriPermissions();
        boolean granted = false, failed = false;
        Set<Uri> seen = new HashSet<>();
        for (UriPermission permission : permissions) {
            if (!permission.isReadPermission() || !DocumentsContract.isTreeUri(permission.getUri())) continue;
            granted = true;
            Uri tree = permission.getUri();
            ArrayDeque<String> pending = new ArrayDeque<>();
            pending.add(DocumentsContract.getTreeDocumentId(tree));
            while (!pending.isEmpty()) {
                cancellation.throwIfCanceled();
                Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, pending.removeFirst());
                if (!seen.add(children)) continue;
                try (Cursor cursor = context.getContentResolver().query(children, new String[]{
                        DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                        DocumentsContract.Document.COLUMN_MIME_TYPE}, null, null, null, cancellation)) {
                    if (cursor == null) { failed = true; continue; }
                    while (cursor.moveToNext()) {
                        cancellation.throwIfCanceled();
                        String id = cursor.getString(0), name = cursor.getString(1), mime = cursor.getString(2);
                        if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) pending.add(id);
                        else if (name != null && new SearchName(name).matches(query)) {
                            result.add(new FileResult(name, DocumentsContract.buildDocumentUriUsingTree(tree, id), mime));
                            // ponytail: cap rendered matches, narrow the query for larger authorized trees.
                            if (result.size() == 100) return "已显示前 100 个文件，请缩小关键词；仅搜索已授权目录的文件名";
                        }
                    }
                } catch (OperationCanceledException failure) { throw failure; }
                catch (RuntimeException failure) { failed = true; }
            }
        }
        if (!granted) return "尚未授权文件夹；授权后仅搜索该范围的文件名";
        return failed ? "部分授权目录不可访问，请重新授权；不搜索文件内容" : "仅搜索已授权目录的文件名，不搜索文件内容";
    }

    private static String defaultAliases(String packageName) {
        return switch (packageName) {
            case "com.tencent.mm" -> "微信 wechat weixin wx";
            case "com.tencent.mobileqq" -> "QQ 腾讯";
            case "com.eg.android.AlipayGphone" -> "支付宝 alipay zfb";
            case "com.android.chrome" -> "谷歌浏览器 chrome browser";
            case "org.mozilla.firefox" -> "火狐浏览器 firefox browser";
            case "com.google.android.dialer", "com.android.contacts", "com.android.dialer" -> "电话 拨号 phone dialer";
            case "com.google.android.apps.messaging", "com.android.mms" -> "短信 信息 sms messages";
            case "com.android.camera", "com.android.camera2", "com.google.android.GoogleCamera" -> "相机 camera";
            case "com.android.settings" -> "设置 settings";
            default -> "";
        };
    }
}
