package com.example.launcherprobe;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.role.RoleManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.view.Gravity;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
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
    private int renderGeneration;
    private java.io.File selectedBackup;
    private List<java.io.File> backupFiles = Collections.emptyList();
    private final Map<String, Drawable> previewIcons = new HashMap<>();
    private record BackupEntry(java.io.File file, JSONObject value, String time) { }
    private String page = "设置";
    private final java.util.concurrent.ExecutorService io = java.util.concurrent.Executors.newSingleThreadExecutor();
    private boolean busy;
    private boolean settingsSnapshotSaved;
    private ShizukuRepair shizukuRepair;
    private TextView gestureState;
    private final Runnable refreshGestures = () -> {
        if (isDestroyed() || gestureState == null) return;
        gestureState.setText(GestureService.status(this));
        gestureState.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
    };

    @Override public void onCreate(Bundle state) {
        colors = AppAppearance.readDesktop(this); colors.apply(this);
        super.onCreate(state);
        prefs = new DesktopPreferences(this); backup = new DesktopBackup(this);
        shizukuRepair = new ShizukuRepair(this, refreshGestures);
        shizukuRepair.register();
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
    @Override protected void onResume() {
        super.onResume();
        GestureService.statusListener = refreshGestures;
        GestureService.recover(this);
        shizukuRepair.resume();
        refreshGestures.run();
    }
    @Override protected void onPause() {
        shizukuRepair.pause();
        if (GestureService.statusListener == refreshGestures) GestureService.statusListener = null;
        super.onPause();
    }
    private void back() { if (page.equals("设置")) finish(); else show("设置"); }
    @Override protected void onDestroy() {
        io.shutdown();
        if (shizukuRepair != null) shizukuRepair.destroy();
        super.onDestroy();
    }
    private int dp(int n) { return Math.round(n * getResources().getDisplayMetrics().density); }
    private void show(String name) { page = name; render(); }
    private void render() {
        colors = AppAppearance.readDesktop(this);
        colors.applySystemBars(this, colors.background);
        getWindow().setBackgroundDrawableResource(android.R.color.transparent);
        renderGeneration++;
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WALLPAPER);
        FrameLayout root = new FrameLayout(this); root.setBackgroundColor(colors.background);
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true); scroll.setVerticalScrollBarEnabled(false);
        content = column(); content.setPadding(dp(16), dp(8), dp(16), dp(16));
        scroll.addView(content); root.addView(scroll, new FrameLayout.LayoutParams(-1, -1));
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            androidx.core.graphics.Insets bars = androidx.core.view.WindowInsetsCompat.toWindowInsetsCompat(insets, view)
                    .getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars()
                            | androidx.core.view.WindowInsetsCompat.Type.displayCutout());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom); return insets;
        });
        setContentView(root); root.requestApplyInsets();
        gestureState = null;
        FrameLayout header = new FrameLayout(this);
        TextView title = text(page, page.equals("设置") ? 25 : 19, colors.ink);
        title.setTypeface(null, Typeface.BOLD);
        title.setGravity(page.equals("设置") ? Gravity.CENTER_VERTICAL : Gravity.CENTER);
        header.addView(title, new FrameLayout.LayoutParams(-1, -1));
        if (!page.equals("设置")) {
            ImageView back = icon("previous", colors.ink, 24);
            back.setPadding(dp(4), dp(12), dp(12), dp(12)); back.setContentDescription("返回设置");
            back.setFocusable(true); back.setOnClickListener(v -> back());
            header.addView(back, new FrameLayout.LayoutParams(dp(40), -1, Gravity.START));
        }
        LinearLayout.LayoutParams headerParams = new LinearLayout.LayoutParams(-1, dp(48));
        headerParams.bottomMargin = dp(8); content.addView(header, headerParams);
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
            case "手势" -> gestures();
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
        LinearLayout searchBar = horizontal(); searchBar.setPadding(dp(14), 0, dp(12), 0);
        searchBar.setBackground(shape(colors.panel, 24)); searchBar.addView(icon("search", colors.muted, 21));
        EditText search = new EditText(this); search.setSingleLine(true); search.setTextColor(colors.ink);
        search.setHintTextColor(colors.muted); search.setHint("搜索设置项"); search.setTextSize(14);
        search.setBackgroundColor(android.graphics.Color.TRANSPARENT); search.setPadding(dp(10), 0, 0, 0);
        search.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_DONE);
        searchBar.addView(search, new LinearLayout.LayoutParams(0, -1, 1));
        addBlock(searchBar, 44, 10);
        LinearLayout shortcuts = horizontal();
        shortcuts.addView(shortcut("desktop", "桌面设置", "布局、图标、小组件", () -> show("桌面")), new LinearLayout.LayoutParams(0, dp(92), 1));
        LinearLayout.LayoutParams assistantParams = new LinearLayout.LayoutParams(0, dp(92), 1); assistantParams.leftMargin = dp(10);
        shortcuts.addView(shortcut("sparkles", "助手设置", "模型、工具与扩展", () -> startActivity(new Intent(this, PiSettingsActivity.class))), assistantParams);
        addBlock(shortcuts, -2, 12);
        String[] names = {"桌面", "Dock 栏", "搜索", "文件夹", "小组件", "手势", "外观", "备份与恢复"};
        String[] descriptions = {"网格、图标大小、锁定布局", "仅在桌面显示", "本地搜索与 AI 入口", "排序与批量添加", "第三方组件与 AI 组件", "上滑应用库，固定导航与三键", "壁纸、图标包、深浅模式", "桌面布局与设置"};
        String[] icons = {"desktop", "dock", "search", "folder", "grid", "gesture", "palette", "cloud"};
        LinearLayout group = group(); List<View> rows = new ArrayList<>(); List<View> dividers = new ArrayList<>();
        for (int i = 0; i < names.length; i++) {
            String name = names[i]; View item = settingRow(icons[i], name, descriptions[i], () -> show(name));
            group.addView(item); rows.add(item);
            View line = divider(group, 38); dividers.add(line); if (i == names.length - 1) line.setVisibility(View.GONE);
        }
        addBlock(group, -2, 12);
        View unavailable = settingRow("lock", "工作资料与私密空间 · 后续支持", "", () -> { });
        unavailable.setPadding(dp(12), dp(9), dp(12), dp(9));
        unavailable.setEnabled(false); unavailable.setAlpha(.48f); unavailable.setBackground(shape(surface(), 14));
        content.addView(unavailable, new LinearLayout.LayoutParams(-1, dp(48)));
        search.addTextChangedListener(new android.text.TextWatcher() {
            public void beforeTextChanged(CharSequence s, int a, int c, int f) { }
            public void onTextChanged(CharSequence s, int start, int before, int count) {
                String query = s.toString().trim().toLowerCase(Locale.ROOT); int last = -1;
                for (int i = 0; i < rows.size(); i++) {
                    boolean visible = (names[i] + descriptions[i]).toLowerCase(Locale.ROOT).contains(query);
                    rows.get(i).setVisibility(visible ? View.VISIBLE : View.GONE);
                    dividers.get(i).setVisibility(visible ? View.VISIBLE : View.GONE); if (visible) last = i;
                }
                if (last >= 0) dividers.get(last).setVisibility(View.GONE);
            }
            public void afterTextChanged(android.text.Editable e) { }
        });
        content.setFocusableInTouchMode(true); content.requestFocus();
    }
    private View shortcut(String image, String title, String description, Runnable action) {
        LinearLayout box = column(); box.setGravity(Gravity.CENTER); box.setBackground(shape(surface(), 14));
        box.addView(icon(image, colors.accent, 30));
        TextView name = text(title, 15, colors.ink); name.setGravity(Gravity.CENTER); name.setTypeface(null, Typeface.BOLD); name.setPadding(0, dp(5), 0, dp(3)); box.addView(name);
        TextView detail = text(description, 12, colors.muted); detail.setGravity(Gravity.CENTER); box.addView(detail); box.setFocusable(true); box.setOnClickListener(v -> action.run()); return box;
    }
    private void backups() {
        int generation = renderGeneration;
        LinearLayout current = horizontal(); current.setPadding(dp(12), dp(14), dp(12), dp(14)); current.setBackground(shape(surface(), 16));
        ImageView cloud = icon("cloud-upload", colors.accent, 40); cloud.setPadding(dp(7), dp(7), dp(7), dp(7)); cloud.setBackground(shape(colors.panel, 24)); current.addView(cloud);
        LinearLayout labels = column(); labels.setPadding(dp(10), 0, dp(6), 0);
        TextView heading = text("备份当前桌面", 15, colors.ink); heading.setTypeface(null, Typeface.BOLD); labels.addView(heading);
        TextView detail = text("保存桌面布局与设置", 12, colors.muted); detail.setPadding(0, dp(6), 0, dp(6)); labels.addView(detail);
        TextView lastBackup = text("正在读取备份…", 11, colors.muted); labels.addView(lastBackup);
        current.addView(labels, new LinearLayout.LayoutParams(0, -2, 1));
        TextView save = button("立即备份"); save.setTextSize(13);
        save.setOnClickListener(v -> runIo(() -> { selectedBackup = backup.snapshot(); return "备份已保存"; }));
        current.addView(save, new LinearLayout.LayoutParams(dp(80), dp(44))); addBlock(current, -2, 12);

        LinearLayout restore = column(); restore.setPadding(dp(12), dp(14), dp(12), dp(14)); restore.setBackground(shape(surface(), 16));
        TextView headingRestore = text("恢复桌面布局", 16, colors.ink); headingRestore.setTypeface(null, Typeface.BOLD); restore.addView(headingRestore);
        HorizontalScrollView scroll = new HorizontalScrollView(this); scroll.setHorizontalScrollBarEnabled(false);
        LinearLayout thumbnails = horizontal(); thumbnails.setGravity(Gravity.TOP); scroll.addView(thumbnails);
        LinearLayout.LayoutParams scrollerParams = new LinearLayout.LayoutParams(-1, -2); scrollerParams.setMargins(0, dp(12), 0, dp(14)); restore.addView(scroll, scrollerParams);
        TextView loading = text("正在读取历史备份…", 13, colors.muted); loading.setPadding(0, dp(24), 0, dp(24)); thumbnails.addView(loading);
        TextView recover = button("恢复此备份"); recover.setEnabled(false); recover.setAlpha(.45f);
        recover.setOnClickListener(v -> { java.io.File file = selectedBackup; if (file != null) confirmRestore(() -> backup.read(file)); });
        restore.addView(recover, new LinearLayout.LayoutParams(-1, dp(48))); addBlock(restore, -2, 12);
        LinearLayout actions = group(); actions.addView(settingRow("list", "管理备份", "", this::manageBackups)); divider(actions, 38);
        actions.addView(settingRow("file", "从文件恢复", "", () -> document(new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("application/json"), IMPORT)));
        addBlock(actions, -2, 0);
        note("保留最近 5 份。缩略图展示备份的首页布局，小组件内容不包含在备份中。\n只备份桌面布局与设置，不包含聊天、密钥、系统壁纸或第三方数据。恢复前自动保存当前桌面；第三方小组件需重新授权绑定。");
        io.execute(() -> {
            List<java.io.File> files = backup.snapshots(); List<BackupEntry> entries = new ArrayList<>(); int unreadable = 0;
            for (java.io.File file : files) try {
                JSONObject value = backup.read(file); DesktopPreferences.validate(value.getJSONObject("settings"));
                value.put("layout", HomeLayout.validateBackup(value.getJSONObject("layout")));
                entries.add(new BackupEntry(file, value, backupTime(value.optLong("createdAt", file.lastModified()))));
            } catch (Exception e) { unreadable++; }
            int failed = unreadable;
            runOnUiThread(() -> {
                if (isDestroyed() || generation != renderGeneration) return;
                backupFiles = files; thumbnails.removeAllViews();
                lastBackup.setText(files.isEmpty() ? "上次备份：暂无" : "上次备份：" + backupTime(files.get(0).lastModified()));
                if (entries.isEmpty()) {
                    TextView empty = text(failed == 0 ? "尚无历史备份，先保存当前桌面" : "无法预览备份，可在管理中处理", 13, colors.muted);
                    empty.setPadding(0, dp(28), 0, dp(28)); thumbnails.addView(empty); selectedBackup = null; return;
                }
                if (entries.stream().noneMatch(entry -> entry.file().equals(selectedBackup))) selectedBackup = entries.get(0).file();
                List<FrameLayout> frames = new ArrayList<>(); List<ImageView> checks = new ArrayList<>(); List<TextView> times = new ArrayList<>();
                java.util.function.Consumer<java.io.File> select = file -> {
                    selectedBackup = file;
                    for (int i = 0; i < entries.size(); i++) {
                        boolean selected = entries.get(i).file().equals(file);
                        GradientDrawable border = shape(colors.panel, 12); border.setStroke(dp(selected ? 2 : 0), colors.accent); frames.get(i).setBackground(border);
                        checks.get(i).setVisibility(selected ? View.VISIBLE : View.GONE); times.get(i).setTextColor(selected ? colors.accent : colors.muted);
                        frames.get(i).setSelected(selected); frames.get(i).setContentDescription(entries.get(i).time() + (selected ? "，已选择" : "，选择备份"));
                    }
                };
                int width = (getResources().getConfiguration().screenWidthDp - 72) / 3;
                for (BackupEntry entry : entries) {
                    LinearLayout tile = column(); tile.setGravity(Gravity.CENTER_HORIZONTAL);
                    FrameLayout frame = new FrameLayout(this); frame.setPadding(dp(3), dp(3), dp(3), dp(3));
                    DesktopBackupPreview preview = new DesktopBackupPreview(this, entry.value(), previewIcons);
                    preview.setBackground(shape(colors.panel, 9)); preview.setClipToOutline(true); frame.addView(preview, new FrameLayout.LayoutParams(-1, -1));
                    ImageView check = icon("check", 0xffffffff, 22); check.setPadding(dp(4), dp(4), dp(4), dp(4)); check.setBackground(shape(colors.accent, 12));
                    FrameLayout.LayoutParams checkParams = new FrameLayout.LayoutParams(dp(22), dp(22), Gravity.TOP | Gravity.END); checkParams.setMargins(dp(5), dp(5), dp(5), dp(5)); frame.addView(check, checkParams);
                    frame.setFocusable(true); frame.setOnClickListener(v -> select.accept(entry.file()));
                    tile.addView(frame, new LinearLayout.LayoutParams(-1, dp(Math.round(width * 1.65f))));
                    TextView time = text(entry.time(), 11, colors.muted); time.setGravity(Gravity.CENTER); time.setPadding(0, dp(6), 0, 0); tile.addView(time);
                    LinearLayout.LayoutParams tileParams = new LinearLayout.LayoutParams(dp(width), -2); tileParams.rightMargin = dp(8); thumbnails.addView(tile, tileParams);
                    frames.add(frame); checks.add(check); times.add(time);
                }
                select.accept(selectedBackup); recover.setEnabled(true); recover.setAlpha(1);
                if (failed > 0) lastBackup.append(" · 部分备份不可用");
            });
        });
    }
    private String backupTime(long time) {
        return android.text.format.DateFormat.format(android.text.format.DateUtils.isToday(time) ? "今天 HH:mm" : "M月d日 HH:mm", time).toString();
    }
    private void manageBackups() {
        List<java.io.File> files = new ArrayList<>(backupFiles); String[] options = new String[files.size() + 1]; options[0] = "导出当前桌面";
        for (int i = 0; i < files.size(); i++) options[i + 1] = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(new Date(files.get(i).lastModified()));
        new AlertDialog.Builder(this).setTitle("管理备份").setItems(options, (dialog, which) -> {
            if (which == 0) { document(new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("application/json").putExtra(Intent.EXTRA_TITLE, "e-launcher-desktop.json"), EXPORT); return; }
            java.io.File file = files.get(which - 1);
            new AlertDialog.Builder(this).setTitle(options[which]).setItems(new String[]{"恢复此备份", "删除此备份"}, (d, action) -> {
                if (action == 0) confirmRestore(() -> backup.read(file));
                else new AlertDialog.Builder(this).setMessage("删除这份历史备份？").setNegativeButton("取消", null)
                        .setPositiveButton("删除", (confirmation, w) -> runIo(() -> { backup.delete(file); return "备份已删除"; })).show();
            }).show();
        }).setNegativeButton("取消", null).show();
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
    private void gestures() {
        String[] labels = {"应用库", "本地搜索", "不操作"}, values = {"library", "search", "none"};
        choice("上滑", "swipeUp", prefs.swipeUp(), labels, values);
        choice("下滑", "swipeDown", prefs.swipeDown(), labels, values);
        note("应用库默认不弹键盘；本地搜索自动聚焦。");
        note("无障碍授权支持固定导航，并允许助手按工具调用读取当前界面结构、点击、输入非密码文字和滚动；密码字段会隐藏。");
        gestureState = text(GestureService.status(this), 13, colors.ink);
        gestureState.setPadding(dp(12), dp(14), dp(12), dp(14));
        gestureState.setBackground(shape(surface(), 14));
        gestureState.setTextIsSelectable(true);
        gestureState.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        addBlock(gestureState, -2, 8);
        LinearLayout nav = group();
        nav.addView(settingRow(null, "使用 Shizuku 修复授权与无障碍", "", () -> shizukuRepair.repairFromButton()));
        divider(nav, 0);
        nav.addView(settingRow(null, "打开无障碍授权设置", "", () -> launch(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))));
        divider(nav, 0);
        nav.addView(settingRow(null, "启用固定导航手势", "", () -> GestureService.enable(this)));
        divider(nav, 0);
        nav.addView(settingRow(null, "停止手势并恢复三键", "", () -> GestureService.disable(this)));
        addBlock(nav, -2, 8);
        LinearLayout launcher = group();
        launcher.addView(settingRow(null, "使用 Shizuku 设为默认桌面", "", this::requestHome));
        divider(launcher, 0);
        launcher.addView(settingRow(null, "默认桌面设置 / 恢复系统桌面", "", () -> launch(new Intent(Settings.ACTION_HOME_SETTINGS))));
        divider(launcher, 0);
        launcher.addView(settingRow(null, "打开系统设置", "", () -> launch(new Intent(Settings.ACTION_SETTINGS))));
        addBlock(launcher, -2, 8);
        LinearLayout safetyBox = group();
        TextView safety = text("可使用 Shizuku 修复写设置授权和本应用的无障碍服务；也可通过电脑 ADB 手动授权：\n"
                + GestureService.GRANT_COMMAND
                + "\n\n左右内滑返回；底边上滑回桌面；上滑停留打开最近任务。"
                + "启用会改变 HyperOS 导航设置。停用后请目视确认三键已恢复，再撤权或卸载。"
                + "\n\nPi 的 Operit Shower 工具也使用同一 Shizuku 授权，仅按工具调用创建和操作虚拟屏；不会操作手机主屏。", 12, colors.muted);
        safety.setPadding(0, dp(8), 0, dp(8));
        safety.setTextIsSelectable(true);
        safety.setVisibility(View.GONE);
        TextView details = text("展开安全说明", 15, colors.accent);
        details.setPadding(0, dp(12), 0, dp(12));
        details.setMinHeight(dp(48));
        details.setGravity(Gravity.CENTER_VERTICAL);
        details.setFocusable(true);
        details.setOnClickListener(v -> {
            boolean expand = safety.getVisibility() != View.VISIBLE;
            safety.setVisibility(expand ? View.VISIBLE : View.GONE);
            details.setText(expand ? "收起安全说明" : "展开安全说明");
        });
        safetyBox.addView(details);
        safetyBox.addView(safety);
        addBlock(safetyBox, -2, 8);
    }
    private void requestHome() {
        RoleManager roles = getSystemService(RoleManager.class);
        if (roles == null || !roles.isRoleAvailable(RoleManager.ROLE_HOME)) {
            Toast.makeText(this, "系统未提供 HOME 角色请求，请使用默认桌面设置入口。", Toast.LENGTH_LONG).show();
            return;
        }
        if (roles.isRoleHeld(RoleManager.ROLE_HOME)) {
            Toast.makeText(this, "已经是默认桌面。", Toast.LENGTH_LONG).show();
            return;
        }
        shizukuRepair.requestHomeFromButton();
    }
    private void launch(Intent intent) {
        try { startActivity(intent); }
        catch (ActivityNotFoundException | SecurityException e) {
            Toast.makeText(this, "无法打开：" + e.getClass().getSimpleName() + "。请从系统设置手动操作；应用也可能已被卸载或禁用。", Toast.LENGTH_LONG).show();
        }
    }
    private void desktop(String action) {
        startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra(EXTRA_ACTION, action)); finish();
    }
    private TextView text(String value, int size, int color) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(color); view.setIncludeFontPadding(false); return view;
    }
    private LinearLayout column() { LinearLayout view = new LinearLayout(this); view.setOrientation(LinearLayout.VERTICAL); return view; }
    private LinearLayout horizontal() { LinearLayout view = new LinearLayout(this); view.setGravity(Gravity.CENTER_VERTICAL); return view; }
    private int surface() { return colors.dark ? 0xff19313c : 0xdfffffff; }
    private GradientDrawable shape(int color, int radius) { GradientDrawable view = new GradientDrawable(); view.setColor(color); view.setCornerRadius(dp(radius)); return view; }
    private ImageView icon(String name, int color, int size) {
        ImageView view = new ImageView(this); view.setImageDrawable(new ChatIcon(name, color)); view.setLayoutParams(new LinearLayout.LayoutParams(dp(size), dp(size))); return view;
    }
    private TextView button(String label) {
        TextView view = text(label, 15, 0xffffffff); view.setGravity(Gravity.CENTER); view.setBackground(shape(colors.accent, 24)); view.setFocusable(true); return view;
    }
    private void addBlock(View view, int height, int bottom) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, height < 0 ? height : dp(height)); params.bottomMargin = dp(bottom); content.addView(view, params);
    }
    private LinearLayout group() { LinearLayout group = column(); group.setPadding(dp(12), 0, dp(12), 0); group.setBackground(shape(surface(), 14)); return group; }
    private View divider(LinearLayout group, int inset) {
        View line = new View(this); line.setBackgroundColor(colors.border); LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(1)); params.leftMargin = dp(inset); group.addView(line, params); return line;
    }
    private View settingRow(String image, String title, String subtitle, Runnable action) {
        LinearLayout body = horizontal(); body.setPadding(0, dp(9), 0, dp(9)); body.setMinimumHeight(dp(56));
        if (image != null) { ImageView leading = icon(image, colors.accent, 24); body.addView(leading); }
        LinearLayout labels = column(); labels.setPadding(dp(image == null ? 0 : 14), 0, dp(8), 0);
        TextView label = text(title, 15, colors.ink); label.setTypeface(null, Typeface.BOLD); labels.addView(label);
        if (!subtitle.isEmpty()) { TextView detail = text(subtitle, 12, colors.muted); detail.setPadding(0, dp(3), 0, 0); labels.addView(detail); }
        body.addView(labels, new LinearLayout.LayoutParams(0, -2, 1)); body.addView(icon("next", colors.muted, 16));
        body.setOnClickListener(v -> action.run()); body.setFocusable(true); return body;
    }
    private View row(String title, String subtitle, Runnable action) {
        LinearLayout group = group(); group.addView(settingRow(null, title, subtitle, action)); addBlock(group, -2, 8); return group;
    }
    private void note(String message) { TextView note = text(message, 12, colors.muted); note.setPadding(dp(4), dp(12), dp(4), dp(12)); note.setLineSpacing(dp(3), 1); content.addView(note); }
    private void set(String key, Object value) {
        runIo(() -> {
            if (!settingsSnapshotSaved) { backup.snapshot(); settingsSnapshotSaved = true; }
            prefs.set(key, value);
            return "桌面设置已保存";
        });
    }
    private void toggle(String label, String key, boolean checked) {
        Switch toggle = new Switch(this); toggle.setText(label); toggle.setTextColor(colors.ink); toggle.setTextSize(15); toggle.setChecked(checked);
        toggle.setPadding(dp(12), dp(12), dp(12), dp(12)); toggle.setMinHeight(dp(56)); toggle.setBackground(shape(surface(), 14));
        toggle.setThumbTintList(new android.content.res.ColorStateList(new int[][]{new int[]{android.R.attr.state_checked}, new int[]{}}, new int[]{colors.accent, colors.muted}));
        toggle.setTrackTintList(new android.content.res.ColorStateList(new int[][]{new int[]{android.R.attr.state_checked}, new int[]{}}, new int[]{0x66000000 | (colors.accent & 0xffffff), colors.border}));
        addBlock(toggle, -2, 8);
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
