package com.example.launcherprobe;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.widget.*;
import org.json.JSONObject;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.DateFormat;
import java.util.*;

/** Native desktop settings; assistant configuration remains in PiSettingsActivity. */
public final class DesktopSettingsActivity extends androidx.activity.ComponentActivity {
    public static final String EXTRA_ACTION = "desktop_settings_action";
    private static final int EXPORT = 41, IMPORT = 42;
    private DesktopPreferences prefs;
    private DesktopBackup backup;
    private AppAppearance colors;
    private LinearLayout content;
    private View wallpaper;
    private String page = "设置";
    private final java.util.concurrent.ExecutorService io = java.util.concurrent.Executors.newSingleThreadExecutor();
    private boolean busy;
    private boolean settingsSnapshotSaved;

    @Override public void onCreate(Bundle state) {
        colors = AppAppearance.readDesktop(this); colors.apply(this);
        super.onCreate(state);
        prefs = new DesktopPreferences(this); backup = new DesktopBackup(this);
        if (state != null) page = state.getString("page", "设置");
        else {
            String destination = getIntent().getStringExtra("desktop_destination");
            if (destination != null) page = switch (destination) {
                case "grid", "layout" -> "桌面";
                case "dock" -> "Dock 栏";
                case "search" -> "搜索";
                case "folders" -> "文件夹";
                case "widgets" -> "小组件";
                case "gestures" -> "手势";
                case "wallpaper", "icons", "theme" -> "外观";
                case "backup" -> "备份与恢复";
                default -> "设置";
            };
        }
        getOnBackPressedDispatcher().addCallback(this, new androidx.activity.OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { back(); }
        });
        render();
    }
    @Override public void onSaveInstanceState(Bundle state) { super.onSaveInstanceState(state); state.putString("page", page); }
    private void back() { if (page.equals("设置")) finish(); else show("设置"); }
    @Override protected void onDestroy() { io.shutdown(); super.onDestroy(); }
    private int dp(int n) { return Math.round(n * getResources().getDisplayMetrics().density); }
    private void show(String name) { page = name; render(); }
    private void render() {
        colors = AppAppearance.readDesktop(this);
        getWindow().getDecorView().setSystemUiVisibility(colors.systemBarFlags());
        getWindow().setBackgroundDrawableResource(android.R.color.transparent);
        if (prefs.wallpaper().equals("system")) getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WALLPAPER);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WALLPAPER);
        FrameLayout root = new FrameLayout(this);
        wallpaper = colors.desktopWallpaper(this); root.addView(wallpaper, new FrameLayout.LayoutParams(-1, -1));
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true);
        content = new LinearLayout(this); content.setOrientation(LinearLayout.VERTICAL); content.setPadding(dp(20), dp(12), dp(20), dp(24));
        scroll.addView(content); root.addView(scroll, new FrameLayout.LayoutParams(-1, -1));
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            androidx.core.graphics.Insets bars = androidx.core.view.WindowInsetsCompat.toWindowInsetsCompat(insets, view)
                    .getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars()
                            | androidx.core.view.WindowInsetsCompat.Type.displayCutout());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom); return insets;
        });
        setContentView(root); root.requestApplyInsets();
        TextView title = text("‹  " + page, 28, colors.ink);
        title.setMinHeight(dp(56)); title.setOnClickListener(v -> back()); content.addView(title);
        switch (page) {
            case "设置" -> home();
            case "桌面" -> {
                number("网格列数", "columns", prefs.columns(), 3, 6);
                number("网格行数", "rows", prefs.rows(), 5, 10);
                note("改变网格后由桌面重新安排超界项目，不删除应用或小组件。");
                number("图标大小 · dp", "iconSize", prefs.iconSizeDp(), 36, 72);
                number("文字大小 · sp", "labelSize", prefs.labelSizeSp(), 10, 22);
                toggle("锁定布局", "locked", prefs.layoutLocked());
            }
            case "Dock 栏" -> {
                toggle("显示 Dock 栏", "dockVisible", prefs.dockVisible());
                row("配置 Dock 应用", "返回桌面编辑独立 Dock", () -> desktop("edit_dock"));
                note("Dock 仅在桌面显示，不出现在应用库、搜索与设置中。");
            }
            case "搜索" -> {
                toggle("搜索快捷方式", "searchShortcuts", prefs.searchShortcuts());
                toggle("搜索已授权文件名称", "searchFiles", prefs.searchFiles());
                note("只搜索获授权可访问范围的文件名称，不搜索全文。非空输入始终可点击发送给 AI 助手。");
            }
            case "文件夹" -> {
                choice("默认排序", "folderSort", prefs.folderSort(), new String[]{"手动排序", "名称排序"}, new String[]{"manual", "name"});
                row("管理文件夹", "在桌面改名、批量添加或调整顺序", () -> desktop("manage_folders"));
                note("文件夹不能嵌套。");
            }
            case "小组件" -> {
                row("添加小组件", "第三方小组件或 AI 会话堆叠", () -> desktop("add_widget"));
                row("移动、调整尺寸与移除", "返回桌面长按小组件操作", () -> desktop("edit_widgets"));
                note("第三方内容和外观由提供方决定。移除 AI 小组件不会删除聊天历史。");
            }
            case "手势" -> {
                String[] labels = {"应用库", "本地搜索", "不操作"}, values = {"library", "search", "none"};
                choice("上滑", "swipeUp", prefs.swipeUp(), labels, values);
                choice("下滑", "swipeDown", prefs.swipeDown(), labels, values);
                note("应用库默认不弹键盘；本地搜索自动聚焦。系统导航手势仍由既有无障碍服务管理。");
            }
            case "外观" -> {
                choice("颜色模式", "theme", prefs.theme(), new String[]{"跟随系统", "浅色", "深色"}, new String[]{"system", "light", "dark"});
                choice("壁纸", "wallpaper", prefs.wallpaper(), new String[]{"浅青渐变", "系统壁纸"}, new String[]{"mint", "system"});
                row("更换系统壁纸", "使用 Android 壁纸选择器", () -> {
                    try { startActivity(Intent.createChooser(new Intent(Intent.ACTION_SET_WALLPAPER), "选择壁纸")); }
                    catch (RuntimeException e) { error(e); }
                });
                row("图标包", prefs.iconPack().isEmpty() ? "系统图标" : prefs.iconPack(), this::iconPacks);
                note("支持已安装的 appfilter 图标包；未提供对应图标的应用保留原图标。桌面颜色模式与助手设置独立。");
            }
            case "备份与恢复" -> backups();
        }
    }
    private void home() {
        EditText search = new EditText(this); search.setSingleLine(true); search.setTextColor(colors.ink);
        search.setHintTextColor(colors.muted); search.setHint("搜索设置项"); content.addView(search);
        row("⌂  桌面设置", "布局、图标、小组件", () -> show("桌面"));
        row("✦  助手设置", "模型、工具与扩展", () -> startActivity(new Intent(this, PiSettingsActivity.class)));
        String[] names = {"桌面", "Dock 栏", "搜索", "文件夹", "小组件", "手势", "外观", "备份与恢复"};
        String[] descriptions = {"网格、图标与文字大小、锁定布局", "仅在桌面显示", "本地搜索与 AI 入口", "排序与批量添加", "第三方组件与 AI 组件", "上滑应用库、下滑搜索", "壁纸、图标包、深浅模式", "桌面布局与设置"};
        List<View> rows = new ArrayList<>();
        for (int i = 0; i < names.length; i++) { String name = names[i]; rows.add(row(name, descriptions[i], () -> show(name))); }
        search.addTextChangedListener(new android.text.TextWatcher() {
            public void beforeTextChanged(CharSequence s, int a, int c, int f) { }
            public void onTextChanged(CharSequence s, int start, int before, int count) {
                String query = s.toString().trim().toLowerCase(Locale.ROOT);
                for (int i = 0; i < rows.size(); i++) rows.get(i).setVisibility((names[i] + descriptions[i]).toLowerCase(Locale.ROOT).contains(query) ? View.VISIBLE : View.GONE);
            }
            public void afterTextChanged(android.text.Editable e) { }
        });
        note("工作资料与私密空间 · 后续支持");
        content.setFocusableInTouchMode(true); content.requestFocus();
    }
    private void backups() {
        row("备份当前桌面", "保存真实布局与设置 · 保留最近 5 份", () -> runIo(() -> { backup.snapshot(); return "备份已保存"; }));
        try {
            List<java.io.File> files = backup.snapshots();
            if (files.isEmpty()) note("尚无历史备份");
            for (java.io.File file : files) {
                String time = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(new Date(file.lastModified()));
                row(time, backup.summary(file), () -> new AlertDialog.Builder(this).setTitle(time)
                        .setItems(new String[]{"恢复此备份", "删除此备份"}, (d, which) -> {
                            if (which == 0) confirmRestore(() -> backup.read(file));
                            else new AlertDialog.Builder(this).setMessage("删除这份历史备份？").setNegativeButton("取消", null)
                                    .setPositiveButton("删除", (dialog, w) -> runIo(() -> { backup.delete(file); return "备份已删除"; })).show();
                        }).show());
            }
        } catch (Exception e) { note("无法读取备份：" + e.getMessage()); }
        row("导出当前桌面", "保存为 JSON 文件", () -> document(new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("application/json")
                .putExtra(Intent.EXTRA_TITLE, "e-launcher-desktop.json"), EXPORT));
        row("从文件恢复", "选择桌面备份 JSON", () -> document(new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("application/json"), IMPORT));
        note("只备份桌面布局与设置，不包含聊天、密钥或第三方应用数据。系统壁纸由 Android 管理，不包含在备份中。恢复前自动保存当前桌面；第三方小组件需重新授权绑定和配置。");
    }
    private void document(Intent intent, int request) {
        try { startActivityForResult(intent.addCategory(Intent.CATEGORY_OPENABLE), request); }
        catch (RuntimeException e) { error(e); }
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (result != RESULT_OK || data == null || data.getData() == null) return;
        android.net.Uri uri = data.getData();
        if (request == EXPORT) runIo(() -> {
            byte[] bytes = backup.capture().toString(2).getBytes(StandardCharsets.UTF_8);
            try (OutputStream output = getContentResolver().openOutputStream(uri, "wt")) {
                if (output == null) throw new java.io.IOException("无法打开导出文件"); output.write(bytes);
            }
            return "桌面已导出";
        });
        if (request == IMPORT) confirmRestore(() -> {
            try (InputStream input = getContentResolver().openInputStream(uri)) {
                if (input == null) throw new java.io.IOException("无法打开备份"); return DesktopBackup.read(input);
            }
        });
    }
    private interface Source { JSONObject get() throws Exception; }
    private void confirmRestore(Source source) {
        new AlertDialog.Builder(this).setTitle("恢复桌面？").setMessage("将替换布局与桌面设置。当前桌面会先保存为历史快照；第三方小组件需重新绑定。")
                .setNegativeButton("取消", null).setPositiveButton("恢复", (d, w) -> runIo(() -> { backup.restore(source.get()); return "桌面已恢复，小组件请重新绑定"; })).show();
    }
    private interface Work { String run() throws Exception; }
    private void runIo(Work work) {
        if (busy) { Toast.makeText(this, "正在处理，请稍候", Toast.LENGTH_SHORT).show(); return; }
        busy = true;
        io.execute(() -> {
            String message;
            try { message = work.run(); } catch (Exception e) { message = "操作失败：" + e.getMessage(); }
            String result = message;
            runOnUiThread(() -> { busy = false; if (!isDestroyed()) { Toast.makeText(this, result, Toast.LENGTH_LONG).show(); render(); } });
        });
    }
    private void iconPacks() {
        Map<String, String> packs = DesktopIconPack.installed(this);
        List<String> ids = new ArrayList<>(); ids.add(""); ids.addAll(packs.keySet());
        List<String> labels = new ArrayList<>(); labels.add("系统图标"); labels.addAll(packs.values());
        choice("图标包", "iconPack", prefs.iconPack(), labels.toArray(new String[0]), ids.toArray(new String[0]), true);
    }
    private void desktop(String action) {
        startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra(EXTRA_ACTION, action)); finish();
    }
    private TextView text(String value, int size, int color) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(color); return view;
    }
    private View row(String title, String subtitle, Runnable action) {
        LinearLayout body = new LinearLayout(this); body.setOrientation(LinearLayout.VERTICAL); body.setPadding(dp(16), dp(15), dp(16), dp(15));
        TextView label = text(title + "  ›", 18, colors.ink); label.setTypeface(null, android.graphics.Typeface.BOLD); body.addView(label);
        TextView detail = text(subtitle, 14, colors.muted); detail.setPadding(0, dp(5), 0, 0); body.addView(detail);
        FrameLayout glass = colors.glass(this, wallpaper, 18); glass.addView(body, new FrameLayout.LayoutParams(-1, -2));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.bottomMargin = dp(9); content.addView(glass, params);
        glass.setOnClickListener(v -> action.run()); glass.setFocusable(true); return glass;
    }
    private void note(String message) { TextView note = text(message, 14, colors.muted); note.setPadding(dp(8), dp(12), dp(8), dp(16)); content.addView(note); }
    private void set(String key, Object value) {
        runIo(() -> {
            if (!settingsSnapshotSaved) { backup.snapshot(); settingsSnapshotSaved = true; }
            prefs.set(key, value);
            return "桌面设置已保存";
        });
    }
    private void toggle(String label, String key, boolean checked) {
        Switch toggle = new Switch(this); toggle.setText(label); toggle.setTextColor(colors.ink); toggle.setTextSize(17); toggle.setChecked(checked);
        toggle.setPadding(dp(12), dp(16), dp(12), dp(16)); toggle.setMinHeight(dp(56)); content.addView(toggle);
        toggle.setOnCheckedChangeListener((button, value) -> set(key, value));
    }
    private void number(String label, String key, int current, int min, int max) {
        row(label, String.valueOf(current), () -> {
            NumberPicker picker = new NumberPicker(this); picker.setMinValue(min); picker.setMaxValue(max); picker.setValue(current); picker.setWrapSelectorWheel(false);
            new AlertDialog.Builder(this).setTitle(label).setView(picker).setNegativeButton("取消", null)
                    .setPositiveButton("保存", (d, w) -> { picker.clearFocus(); set(key, picker.getValue()); }).show();
        });
    }
    private void choice(String label, String key, String value, String[] labels, String[] values) { choice(label, key, value, labels, values, false); }
    private void choice(String label, String key, String value, String[] labels, String[] values, boolean immediate) {
        int found = Arrays.asList(values).indexOf(value); int selected = Math.max(0, found);
        Runnable open = () -> new AlertDialog.Builder(this).setTitle(label).setSingleChoiceItems(labels, selected, (d, which) -> { d.dismiss(); set(key, values[which]); }).setNegativeButton("取消", null).show();
        if (immediate) open.run(); else row(label, labels[selected], open);
    }
    private void error(Exception e) { Toast.makeText(this, "无法完成：" + e.getMessage(), Toast.LENGTH_LONG).show(); }
}
