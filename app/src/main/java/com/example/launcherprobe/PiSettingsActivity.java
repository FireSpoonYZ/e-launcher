package com.example.launcherprobe;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Native, single-column settings. File and form editing use the same PiConfigStore. */
public final class PiSettingsActivity extends Activity {
    private int IVORY, INK, TEAL, MUTED;
    private AppAppearance appearance;
    private static final String[] CATEGORIES = {"通用", "外观", "服务商", "技能", "MCP", "扩展", "关于", "高级配置"};
    private static final String[] ADVANCED = {"模型与思考", "模型专家配置", "上下文与会话", "请求与消息", "工具与 Shell",
            "网络与连接", "资源与包", "作用域与信任", "环境与凭据", "配置文件", "隐私与诊断", "终端与渲染"};
    private PiConfigStore store;
    private JSONArray fields;
    private LinearLayout shell, content, toolbar;
    private TextView status;
    private EditText editor;
    private String page = "设置", fileName, expected, cleanBuffer;
    private boolean project, updatingEditor;
    private final ArrayDeque<String> back = new ArrayDeque<>();
    private String exportText;
    private int renderVersion;
    private boolean queryRunning;
    private okhttp3.Call publicCall;
    private int publicRequest;
    private String communityQuery = "", communityKind = "";
    private int communityOffset;
    private JSONArray packageSnapshot;
    private android.app.ProgressDialog queryProgress;
    private final Map<String, AlertDialog> authDialogs = new LinkedHashMap<>();
    private AlertDialog authNotice;
    private String authUrl = "", authInstructions = "";
    private volatile PiAgentBridge queryBridge;
    private volatile String queryRequestId;
    private final java.util.concurrent.ExecutorService queries = java.util.concurrent.Executors.newSingleThreadExecutor();

    @Override protected void attachBaseContext(android.content.Context base) { super.attachBaseContext(UiText.wrap(base)); }
    private String t(String literal) { return UiText.get(this, literal); }

    @Override public void onCreate(Bundle state) {
        appearance = AppAppearance.read(this); appearance.apply(this);
        IVORY = appearance.background; INK = appearance.ink; TEAL = appearance.accent; MUTED = appearance.muted;
        super.onCreate(state);
        getWindow().setStatusBarColor(IVORY);
        getWindow().setNavigationBarColor(IVORY);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        getWindow().getDecorView().setSystemUiVisibility(appearance.systemBarFlags());
        store = new PiConfigStore(this);
        try {
            store.initialize(getSharedPreferences("chat", MODE_PRIVATE));
            try (InputStream input = getAssets().open("pi-settings-fields.json")) {
                fields = new JSONArray(readText(input));
            }
            if (state != null) {
                project = state.getBoolean("project");
                communityQuery = state.getString("communityQuery", "");
                communityKind = state.getString("communityKind", "");
                communityOffset = state.getInt("communityOffset", 0);
                page = state.getString("page", "设置");
                ArrayList<String> stack = state.getStringArrayList("back");
                if (stack != null) back.addAll(stack);
            }
            if (state == null && getIntent().getBooleanExtra("pickModel", false)) page = "服务商";
            render();
            if (state == null && getIntent().getBooleanExtra("pickModel", false)) catalog(false);
        } catch (Exception exception) {
            base(t("配置读取失败"));
            note(exception.getMessage());
            action(t("返回"), this::finish);
        }
    }

    @Override protected void onSaveInstanceState(Bundle out) {
        retainDraft();
        out.putString("page", page);
        out.putBoolean("project", project);
        out.putString("communityQuery", communityQuery);
        out.putString("communityKind", communityKind);
        out.putInt("communityOffset", communityOffset);
        out.putStringArrayList("back", new ArrayList<>(back));
        super.onSaveInstanceState(out);
    }

    @Override protected void onPause() {
        retainDraft();
        super.onPause();
    }

    @Override protected void onDestroy() {
        closeAuthDialogs();
        if (queryProgress != null) queryProgress.dismiss();
        if (queryBridge != null) queryBridge.abort(queryRequestId);
        if (publicCall != null) publicCall.cancel();
        queries.shutdown();
        super.onDestroy();
    }

    private String draftKey() { return (project ? "project/" : "global/") + fileName; }

    private void retainDraft() {
        if (editor == null || fileName == null) return;
        if (dirty()) getPreferences(MODE_PRIVATE).edit().putString(draftKey(), editor.getText().toString())
                .putString(draftKey() + "/base", expected).apply();
        else clearDraft();
    }

    private void clearDraft() {
        if (fileName != null) getPreferences(MODE_PRIVATE).edit().remove(draftKey()).remove(draftKey() + "/base").apply();
    }

    private boolean dirty() { return editor != null && !editor.getText().toString().equals(cleanBuffer); }

    private void leave(Runnable next) {
        if (!dirty()) { next.run(); return; }
        new AlertDialog.Builder(this).setTitle(t("尚未保存"))
                .setMessage(t("保留草稿后离开，或放弃这次修改。"))
                .setPositiveButton(t("保留草稿"), (dialog, which) -> { retainDraft(); next.run(); })
                .setNegativeButton(t("放弃修改"), (dialog, which) -> { clearDraft(); editor = null; next.run(); })
                .setNeutralButton(t("继续编辑"), null).show();
    }

    @Override public void onBackPressed() {
        leave(() -> {
            if (back.isEmpty()) finish();
            else { page = back.removeLast(); render(); }
        });
    }

    private void go(String next) {
        leave(() -> { packageSnapshot = null; back.addLast(page); page = next; render(); });
    }

    private void base(String title) {
        renderVersion++;
        publicRequest++;
        if (publicCall != null) { publicCall.cancel(); publicCall = null; }
        editor = null; fileName = null;
        shell = column(); shell.setBackgroundColor(IVORY);
        toolbar = row(); toolbar.setPadding(dp(8), 0, dp(8), 0);
        Button up = button("‹", this::onBackPressed); up.setContentDescription(t("返回"));
        toolbar.addView(up, new LinearLayout.LayoutParams(dp(48), dp(56)));
        TextView heading = text(title, 23, INK); heading.setTypeface(null, Typeface.BOLD);
        toolbar.addView(heading, new LinearLayout.LayoutParams(0, -2, 1));
        shell.addView(toolbar);
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true);
        content = column(); content.setPadding(dp(16), dp(8), dp(16), dp(24));
        scroll.addView(content);
        shell.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        shell.setOnApplyWindowInsetsListener((view, insets) -> {
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets occupied = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                view.setPadding(occupied.left, occupied.top, occupied.right, occupied.bottom);
            } else view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        setContentView(shell);
    }

    private void render() {
        base(t(page.startsWith("file:") ? "配置文件" : page));
        try {
            if (page.startsWith("file:")) { fileEditor(page.substring(5)); return; }
            if (page.equals("设置")) {
                for (String category : CATEGORIES) link(t(category), category.equals("高级配置") ? t("Pi 文件、作用域与运行环境") : "", () -> go(category));
            } else if (page.equals("高级配置")) {
                scope();
                EditText search = input(t("搜索名称或配置键"), "");
                LinearLayout entries = column(); content.addView(entries);
                for (String group : ADVANCED) {
                    Button button = button(t(group) + "  ›", () -> go(group));
                    entries.addView(button, new LinearLayout.LayoutParams(-1, -2));
                }
                search.addTextChangedListener(watcher(() -> {
                    String query = search.getText().toString().trim().toLowerCase(java.util.Locale.ROOT);
                    entries.removeAllViews();
                    if (query.isEmpty()) {
                        for (String group : ADVANCED) entries.addView(button(t(group) + "  ›", () -> go(group)));
                    } else for (int i = 0; i < fields.length(); i++) {
                        JSONObject field = fields.optJSONObject(i);
                        if ((field.optString("key") + field.optString("label") + t(field.optString("label"))).toLowerCase(java.util.Locale.ROOT).contains(query)) {
                            entries.addView(button(t(field.optString("label")) + "\n" + field.optString("key"), () -> editField(field)));
                        }
                    }
                }));
                note(t("Pi 配置格式 0.85.1。Pi Agent 使用完整 SDK 读取设置和资源。终端专用选项保留在文件中，不改变 Android 界面。"));
            } else if (page.equals("通用")) {
                String[] languages = {"system", "zh", "en"};
                String[] languageLabels = {t("跟随系统 / System"), t("简体中文"), "English"};
                int selectedLanguage = java.util.Arrays.asList(languages).indexOf(getSharedPreferences("ui", MODE_PRIVATE).getString("language", "system"));
                link(t("语言"), languageLabels[Math.max(0, selectedLanguage)], () -> new AlertDialog.Builder(this).setTitle(t("语言"))
                        .setSingleChoiceItems(languageLabels, selectedLanguage, (dialog, which) -> {
                            getSharedPreferences("ui", MODE_PRIVATE).edit().putString("language", languages[which]).apply();
                            dialog.dismiss(); recreate();
                        }).setNegativeButton(t("取消"), null).show());
                note(t("当前运行方式"));
                boolean pi = getSharedPreferences("chat", MODE_PRIVATE).getBoolean("pi_text_mode", false);
                link(t("Agent 模式"), pi ? "Pi Agent" : t("Android 工具模式"), () -> new AlertDialog.Builder(this)
                        .setTitle(t("Agent 模式")).setSingleChoiceItems(new String[]{t("Android 工具模式"), "Pi Agent"}, pi ? 1 : 0,
                                (dialog, which) -> { getSharedPreferences("chat", MODE_PRIVATE).edit().putBoolean("pi_text_mode", which == 1).apply(); dialog.dismiss(); render(); }).show());
                action(t("Android 工具模式连接与搜索设置"), () -> { setResult(RESULT_OK, new Intent().putExtra("legacy", true)); finish(); });
                action(t("Android 应用权限"), () -> startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        android.net.Uri.parse("package:" + getPackageName()))));
            } else if (page.equals("服务商")) providers();
            else if (page.equals("配置文件")) {
                scope();
                for (String name : store.files(project)) link(name, name.equals("auth.json") ? t("凭据文件，打开后可能包含密钥") : "", () -> openFile(name));
                action(t("新建文件"), () -> {
                    EditText name = new EditText(this); name.setHint("extensions/example.json");
                    new AlertDialog.Builder(this).setTitle(t("配置文件名")).setView(name).setPositiveButton(t("创建"), (d, w) -> openFile(name.getText().toString())).setNegativeButton(t("取消"), null).show();
                });
            } else if (page.equals("模型专家配置")) {
                note(t("在 models.json 中编辑服务商、模型定义、费用、采样参数、thinkingLevelMap、modelOverrides 与 compat。协议与模型能力由 Pi SDK 解析。"));
                link(t("完整模型配置"), "models.json", () -> { project = false; openFile("models.json"); });
            } else if (page.equals("环境与凭据")) {
                note(t("服务商环境变量使用 auth.json 中的 env。Pi SDK 解析凭据引用并刷新 OAuth。账号登录通过服务商目录发起，授权页面使用系统浏览器。"));
                link(t("账号与服务商环境变量"), "auth.json", () -> { project = false; openFile("auth.json"); });
                link(t("系统提示词"), "SYSTEM.md", () -> { project = false; openFile("SYSTEM.md"); });
                link(t("追加系统提示词"), "APPEND_SYSTEM.md", () -> { project = false; openFile("APPEND_SYSTEM.md"); });
            } else if (page.equals("技能") || page.equals("扩展") || page.equals("MCP")) {
                note(page.equals("MCP") ? t("Pi 核心不内置 MCP，通过扩展接入。") : t("Pi SDK 按全局与工作区资源配置加载。"));
                scope();
                action(t("启用或停用资源"), this::resourceControls);
                action(t("管理已配置的包"), this::packages);
                action(t("安装包"), this::installPackage);
                action(t("扩展社区"), () -> go("扩展社区"));
                action(t("读取资源与诊断"), this::resources);
                link(t("资源配置"), t("保存路径与包过滤配置"), () -> go("资源与包"));
                link(t("扩展配置文件"), t("新建、导入和编辑"), () -> go("配置文件"));
            } else if (page.equals("外观")) {
                appearanceSettings();
                link(t("Pi 终端设置"), t("仅 CLI / TUI 使用"), () -> go("终端与渲染"));
            } else if (page.equals("关于")) {
                android.content.pm.PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
                note("E Launcher\n" + t("应用版本：") + info.versionName + " (" + info.getLongVersionCode() + ")");
                note(t("Pi Coding Agent SDK 0.85.1 · 本地 Node Agent"));
                action(t("源码"), () -> openPublicUrl(SettingsCatalog.REPOSITORY));
                action(t("反馈问题"), () -> openPublicUrl(SettingsCatalog.REPOSITORY + "/issues"));
                TextView release = text("", 15, INK); content.addView(release);
                action(t("检查更新"), () -> checkRelease(release));
                note(t("仅查询公开发布，不自动下载或安装；发布标签不代表一定适用于当前版本。"));
                action(t("Pi 文档"), () -> openPublicUrl("https://pi.dev"));
            } else if (page.equals("扩展社区")) community();
            else fieldGroup(page);
        } catch (Exception exception) { note(t("无法读取：") + exception.getMessage()); }
    }

    private void appearanceSettings() {
        android.content.SharedPreferences preferences = getSharedPreferences("ui", MODE_PRIVATE);
        String[] themes = {"system", "light", "dark"}, themeLabels = {t("跟随系统"), t("浅色"), t("深色")};
        int theme = java.util.Arrays.asList(themes).indexOf(preferences.getString("theme", "system"));
        link(t("应用主题"), themeLabels[Math.max(0, theme)], () -> new AlertDialog.Builder(this).setTitle(t("应用主题"))
                .setSingleChoiceItems(themeLabels, theme, (dialog, which) -> {
                    preferences.edit().putString("theme", themes[which]).apply(); dialog.dismiss(); recreate();
                }).setNegativeButton(t("取消"), null).show());
        String[] backgrounds = {"circles", "solid", "image"}, backgroundLabels = {t("装饰圆"), t("纯色"), t("图片")};
        int background = java.util.Arrays.asList(backgrounds).indexOf(preferences.getString("background", "circles"));
        link(t("首页背景"), backgroundLabels[Math.max(0, background)], () -> new AlertDialog.Builder(this).setTitle(t("首页背景"))
                .setSingleChoiceItems(backgroundLabels, background, (dialog, which) -> {
                    dialog.dismiss();
                    if (which == 2 && !new java.io.File(getFilesDir(), "appearance/background.png").isFile()) { chooseBackgroundImage(); return; }
                    BackgroundImage.setMode(this, backgrounds[which]); render();
                }).setNegativeButton(t("取消"), null).show());
        action(t("导入首页背景图片"), this::chooseBackgroundImage);
        action(t("清除已导入图片"), () -> {
            if (queryRunning) { toast(t("请等待当前操作完成")); return; }
            try { BackgroundImage.clear(this); render(); }
            catch (java.io.IOException exception) { toast(t("无法清除图片")); }
        });
        note(t("背景预览"));
        android.widget.FrameLayout preview = new android.widget.FrameLayout(this);
        content.addView(preview, new LinearLayout.LayoutParams(-1, dp(180)));
        Runnable redraw = () -> {
            preview.removeAllViews(); preview.addView(appearance.wallpaper(this), new android.widget.FrameLayout.LayoutParams(-1, -1));
            TextView sample = text(t("首页文字预览"), 20, INK); sample.setPadding(dp(12), dp(12), dp(12), dp(12));
            sample.setBackgroundColor((appearance.background & 0xffffff) | 0xe6000000);
            preview.addView(sample, new android.widget.FrameLayout.LayoutParams(-2, -2, Gravity.CENTER));
        };
        redraw.run();
        TextView strength = text(t("遮罩强度：") + AppAppearance.maskStrength(this) + "%", 16, INK); content.addView(strength);
        android.widget.SeekBar mask = new android.widget.SeekBar(this); mask.setMax(80); mask.setProgress(AppAppearance.maskStrength(this) - 20);
        mask.setContentDescription(t("遮罩强度，20–100%")); content.addView(mask);
        mask.setOnSeekBarChangeListener(new android.widget.SeekBar.OnSeekBarChangeListener() {
            public void onProgressChanged(android.widget.SeekBar bar, int value, boolean user) {
                strength.setText(t("遮罩强度：") + (value + 20) + "%");
                if (!user) return;
                preferences.edit().putInt("backgroundMask", value + 20).apply();
                View wallpaper = preview.getChildAt(0);
                if (wallpaper instanceof android.widget.ImageView)
                    ((android.widget.ImageView) wallpaper).setColorFilter(appearance.maskColor(PiSettingsActivity.this), android.graphics.PorterDuff.Mode.SRC_ATOP);
            }
            public void onStartTrackingTouch(android.widget.SeekBar bar) { }
            public void onStopTrackingTouch(android.widget.SeekBar bar) { }
        });
        note(t("图片只保存在本机，最长边缩小至 1600 像素。聊天页面使用主题底色。Pi 的终端主题与 Android 外观分别管理。"));
    }

    private void chooseBackgroundImage() {
        if (queryRunning) { toast(t("请等待当前操作完成")); return; }
        startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE), 3);
    }

    private void importBackgroundImage(android.net.Uri uri) {
        queryRunning = true;
        android.app.ProgressDialog progress = android.app.ProgressDialog.show(this, t("首页背景"), t("正在导入…"), true, false);
        queryProgress = progress;
        long operation = BackgroundImage.beginImport();
        queries.execute(() -> {
            String failure = null;
            try { if (!BackgroundImage.importImage(getApplicationContext(), uri, operation)) failure = t("背景操作已被取代"); }
            catch (Exception exception) { failure = exception.getMessage(); }
            catch (OutOfMemoryError error) { failure = t("图片占用内存过大，请选择较小的图片"); }
            String error = failure;
            runOnUiThread(() -> {
                queryRunning = false;
                if (isDestroyed()) return;
                progress.dismiss();
                if (error == null) { toast(t("背景已导入")); render(); } else toast(error);
            });
        });
    }

    private void openPublicUrl(String url) {
        android.net.Uri uri = android.net.Uri.parse(url);
        if (!"https".equals(uri.getScheme())) { toast(t("链接必须使用 HTTPS")); return; }
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
        catch (Exception exception) { toast(t("无法打开链接：") + exception.getMessage()); }
    }

    private void publicJson(okhttp3.HttpUrl url, boolean release, TextView message, java.util.function.Consumer<JSONObject> done) {
        if (publicCall != null) publicCall.cancel();
        int request = ++publicRequest, version = renderVersion;
        okhttp3.Call call = SettingsCatalog.call(url); publicCall = call;
        message.setText(t("读取中…"));
        queries.execute(() -> {
            JSONObject result = null; String failure = null;
            try { result = SettingsCatalog.read(call, release); }
            catch (Exception exception) { failure = exception.getMessage(); }
            JSONObject value = result; String error = failure;
            runOnUiThread(() -> {
                if (isDestroyed() || call.isCanceled() || request != publicRequest || version != renderVersion) return;
                publicCall = null;
                if (error != null) { message.setText(t("读取失败：") + error); return; }
                try { done.accept(value); }
                catch (Exception exception) { message.setText(t("读取失败：") + exception.getMessage()); }
            });
        });
    }

    private void checkRelease(TextView message) {
        message.setOnClickListener(null);
        publicJson(okhttp3.HttpUrl.parse("https://api.github.com/repos/FireSpoonYZ/e-launcher/releases/latest"), true, message, release -> {
            if (release == null) { message.setText(t("未找到公开发布")); return; }
            String tag = release.optString("tag_name"), url = release.optString("html_url");
            if (tag.isEmpty() || !url.startsWith(SettingsCatalog.REPOSITORY + "/releases/")) {
                message.setText(t("读取失败：") + t("发布数据无效")); return;
            }
            message.setText(t("最新公开发布：") + tag + "\n" + url + "\n" + t("点击查看发布说明"));
            message.setOnClickListener(view -> openPublicUrl(url));
        });
    }

    private JSONArray configuredPackages() throws Exception {
        if (packageSnapshot != null) return packageSnapshot;
        JSONArray result = new JSONArray();
        for (boolean local : new boolean[]{false, true}) {
            Object configured = store.settings(local).get("packages");
            if (!(configured instanceof List)) continue;
            for (Object value : (List<?>) configured) {
                Object source = value instanceof Map ? ((Map<?, ?>) value).get("source") : value;
                if (source instanceof String) result.put(new JSONObject().put("source", source).put("scope", local ? "project" : "user").put("filtered", value instanceof Map));
            }
        }
        return result;
    }

    private String packageStatus(JSONObject item) {
        String state = packageSnapshot == null ? t("已配置 · 安装状态未检查")
                : item.optString("installedPath").isEmpty() ? t("已配置 · 未找到安装路径") : t("已配置 · SDK 已找到安装路径（加载可用性未验证）");
        return item.optString("source") + (item.optString("scope").equals("project") ? t(" · 工作区") : t(" · 全局"))
                + "\n" + state + (item.optBoolean("filtered") ? t(" · 含资源过滤配置") : "");
    }

    private void community() throws Exception {
        scope();
        note(t("npm 公共社区；类型仅按关键词分类，未解析包内容。安装第三方包可能执行代码，请仅安装可信来源。"));
        EditText query = input(t("搜索包名称或描述"), communityQuery);
        query.addTextChangedListener(watcher(() -> communityQuery = query.getText().toString()));
        String[] kinds = {"", "extension", "skill", "theme", "prompt"};
        String[] labels = {t("全部类型"), t("扩展关键词"), t("技能关键词"), t("主题关键词"), t("提示词关键词")};
        action(t("类型筛选：") + labels[java.util.Arrays.asList(kinds).indexOf(communityKind)], () ->
                new AlertDialog.Builder(this).setTitle(t("关键词分类")).setItems(labels, (d, which) -> {
                    communityKind = kinds[which]; communityOffset = 0; render();
                }).setNegativeButton(t("取消"), null).show());
        action(t("查询"), () -> { communityOffset = 0; render(); });
        action(t("检查配置与安装状态（SDK）"), () -> runQuery("packages", new JSONObject(), value -> {
            packageSnapshot = (JSONArray) value; render();
        }));
        action(t("管理已配置的包"), this::packages);
        note(t("安装路径存在不代表资源已成功加载；可在资源与诊断中检查。"));
        JSONArray configured = configuredPackages();
        TextView message = text("", 15, MUTED); content.addView(message);
        LinearLayout results = column(); content.addView(results);
        LinearLayout paging = row(); content.addView(paging);
        Button previous = button(t("上一页"), () -> { communityOffset = Math.max(0, communityOffset - SettingsCatalog.PAGE_SIZE); render(); });
        Button next = button(t("下一页"), () -> { communityOffset += SettingsCatalog.PAGE_SIZE; render(); });
        paging.addView(previous); paging.addView(next); previous.setEnabled(communityOffset > 0); next.setEnabled(false);
        int offset = communityOffset;
        publicJson(SettingsCatalog.searchUrl(communityQuery, communityKind, offset), false, message, response -> {
            JSONArray objects = response.optJSONArray("objects");
            if (objects == null || !response.has("total")) { message.setText(t("读取失败：") + t("社区数据无效")); return; }
            long total = response.optLong("total"); int shown = 0;
            for (int i = 0; i < objects.length(); i++) {
                JSONObject entry = objects.optJSONObject(i), item = entry == null ? null : entry.optJSONObject("package");
                if (item == null || !SettingsCatalog.keyword(item, "pi-package") || !SettingsCatalog.keyword(item, communityKind)) continue;
                shown++;
                String name = item.optString("name");
                TextView title = text(name + " · " + item.optString("version"), 18, INK); results.addView(title);
                JSONObject publisher = item.optJSONObject("publisher"), downloads = entry.optJSONObject("downloads");
                StringBuilder details = new StringBuilder(item.optString("description"));
                details.append("\n").append(t("作者（发布者）：")).append(publisher == null ? t("未知") : publisher.optString("username", t("未知")));
                details.append("\n").append(t("月下载量：")).append(downloads == null ? t("未知") : downloads.optString("monthly", t("未知")));
                details.append(t(" · 周下载量：")).append(downloads == null ? t("未知") : downloads.optString("weekly", t("未知")));
                boolean found = false;
                for (int j = 0; j < configured.length(); j++) {
                    JSONObject installed = configured.optJSONObject(j);
                    if (SettingsCatalog.matchesSource(installed.optString("source"), name)) { found = true; details.append("\n").append(packageStatus(installed)); }
                }
                if (!found) details.append("\n").append(t("未配置（不推断其他位置的安装状态）"));
                results.addView(text(details.toString(), 14, MUTED));
                results.addView(button(t("安装此版本"), () -> {
                    final String source;
                    try { source = SettingsCatalog.installSource(item); }
                    catch (Exception exception) { toast(t("包数据无效，无法安装")); return; }
                    boolean local = project;
                    new AlertDialog.Builder(this).setTitle(local ? t("安装到工作区") : t("全局安装"))
                            .setMessage(source + "\n" + t("第三方包可能执行代码。需要运行环境中有 npm 命令；失败会显示实际错误。"))
                            .setPositiveButton(t("安装"), (d, w) -> packageOperation("install", source, local))
                            .setNegativeButton(t("取消"), null).show();
                }));
            }
            message.setText(t("搜索结果总数：") + total + t(" · 页码：") + (offset / SettingsCatalog.PAGE_SIZE + 1)
                    + (shown == 0 ? "\n" + t("本页没有符合关键词的包，可尝试下一页或更换查询。") : ""));
            next.setEnabled(objects.length() > 0 && (long) offset + SettingsCatalog.PAGE_SIZE < total);
        });
    }

    private void scope() {
        Button scope = button(project ? t("工作区 ▾") : t("全局 ▾"), () -> new AlertDialog.Builder(this).setTitle(t("配置范围"))
                .setSingleChoiceItems(new String[]{t("全局"), t("默认工作区")}, project ? 1 : 0, (dialog, which) -> {
                    project = which == 1; dialog.dismiss(); render();
                }).show());
        toolbar.addView(scope);
    }

    private void fieldGroup(String group) throws Exception {
        scope();
        note(group.equals("终端与渲染") ? t("终端字段仅在 Pi CLI / TUI 中生效。Android 渲染不会自动采用这些配置。")
                : t("修改保存到 settings.json，下一次 Pi 请求读取。长按配置项可恢复继承。应用管理的工作区默认受信任，终端启动选项不控制 Android 权限。"));
        Map<String, Object> local = store.settings(project);
        Map<String, Object> effective = store.effectiveSettings();
        for (int i = 0; i < fields.length(); i++) {
            JSONObject field = fields.getJSONObject(i);
            if (!group.equals(field.getString("group"))) continue;
            String key = field.getString("key");
            Object value = ConfigJson.get(local, key);
            Object inherited = ConfigJson.get(effective, key);
            String display = value == null ? t("继承 / 默认：") + (inherited == null ? field.optString("default") : summary(inherited)) : summary(value);
            LinearLayout entry = link(t(field.getString("label")), key + "\n" + display,
                    () -> editField(field));
            if (project && field.optBoolean("globalOnly")) { entry.setEnabled(false); entry.setAlpha(.5f); }
            else entry.setOnLongClickListener(view -> { resetField(field); return true; });
        }
        link(t("编辑完整 JSON"), "settings.json", () -> openFile("settings.json"));
    }

    private String summary(Object value) {
        String text = value instanceof String ? (String) value : ConfigJson.encode(value).trim();
        return text.length() > 140 ? text.substring(0, 140) + "…" : text;
    }

    private void editField(JSONObject field) {
        try {
            if (project && field.optBoolean("globalOnly")) { toast(t("此配置只允许在全局设置")); return; }
            String original = store.read(project, "settings.json");
            Map<String, Object> root = ConfigJson.object(original);
            String key = field.getString("key");
            Object value = ConfigJson.get(root, key);
            LinearLayout body = column(); body.setPadding(dp(20), dp(8), dp(20), 0);
            TextView hint = text(key + t("\n类型：") + field.optString("type") + t("\n默认：") + field.optString("default"), 14, MUTED); body.addView(hint);
            EditText input = new EditText(this); input.setMinLines(2); input.setMaxLines(8);
            boolean plain = field.optString("type").equals("string");
            input.setText(value == null ? "" : plain ? String.valueOf(value) : ConfigJson.encode(value).trim());
            input.setHint(plain ? t("输入文本，不需要引号") : t("输入 JSON 值，如 true、3、[]、{}")); body.addView(input);
            JSONArray allowed = field.optJSONArray("options");
            if (field.optString("type").equals("boolean")) allowed = new JSONArray().put(false).put(true);
            final JSONArray choices = allowed;
            android.widget.Spinner picker = new android.widget.Spinner(this);
            if (choices != null) {
                String[] labels = new String[choices.length()];
                Object selected = value;
                if (selected == null) try { selected = ConfigJson.object("{\"value\":" + field.optString("default") + "}").get("value"); }
                catch (Exception ignored) { /* No documented default. The picker shows its first explicit value. */ }
                int position = 0;
                for (int i = 0; i < labels.length; i++) {
                    Object option = choices.get(i);
                    labels[i] = option instanceof Boolean ? (Boolean.TRUE.equals(option) ? t("开启") : t("关闭")) : String.valueOf(option);
                    if (ConfigJson.sameValue(selected, option)) position = i;
                }
                picker.setAdapter(new android.widget.ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, labels));
                picker.setSelection(position); picker.setContentDescription(t(field.optString("label")));
                body.addView(picker); input.setVisibility(View.GONE);
            } else if (field.optString("type").equals("number")) input.setInputType(android.text.InputType.TYPE_CLASS_NUMBER);
            TextView error = text("", 14, appearance.error); body.addView(error);
            AlertDialog dialog = new AlertDialog.Builder(this).setTitle(t(field.optString("label"))).setView(body)
                    .setPositiveButton(t("保存"), null).setNegativeButton(t("取消"), null).setNeutralButton(t("恢复继承"), null).create();
            dialog.setOnShowListener(ignored -> {
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
                    try {
                        String entered = input.getText().toString();
                        Object next = choices != null ? choices.get(picker.getSelectedItemPosition())
                                : plain ? entered : ConfigJson.object("{\"value\":" + entered + "}").get("value");
                        validateField(field, next);
                        ConfigJson.set(root, key, next, false);
                        store.save(project, "settings.json", ConfigJson.encode(root), original);
                        dialog.dismiss(); toast(t("已保存配置")); render();
                    } catch (Exception exception) { error.setText(exception.getMessage()); }
                });
                dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(v -> {
                    try { ConfigJson.set(root, key, null, true); store.save(project, "settings.json", ConfigJson.encode(root), original); dialog.dismiss(); render(); }
                    catch (Exception exception) { error.setText(exception.getMessage()); }
                });
            });
            dialog.show();
        } catch (Exception exception) { toast(exception.getMessage()); }
    }

    static void validateField(JSONObject field, Object value) {
        String type = field.optString("type");
        if (type.equals("string") && !(value instanceof String)) throw new IllegalArgumentException("请输入文本");
        if (type.equals("string[]") && value instanceof List) {
            for (Object item : (List<?>) value) if (!(item instanceof String)) throw new IllegalArgumentException("数组中的每一项必须是文本");
        }
        JSONArray options = field.optJSONArray("options");
        if (options != null) {
            boolean found = false;
            for (int i = 0; i < options.length(); i++) if (ConfigJson.sameValue(value, options.opt(i))) found = true;
            if (!found) throw new IllegalArgumentException("请选择允许的值");
        }
        if (type.equals("number")) {
            if (!ConfigJson.isNumber(value)) throw new IllegalArgumentException("请输入数字");
            java.math.BigDecimal number = new java.math.BigDecimal(value.toString()).stripTrailingZeros();
            if (number.scale() > 0 || number.compareTo(java.math.BigDecimal.valueOf(field.optLong("min", 0))) < 0
                    || number.compareTo(java.math.BigDecimal.valueOf(field.optLong("max", 9007199254740991L))) > 0) {
                throw new IllegalArgumentException("请输入范围内的非负整数");
            }
        }
        if (type.equals("boolean") && !(value instanceof Boolean)) throw new IllegalArgumentException("请输入 true 或 false");
        if ((type.equals("array") || type.equals("string[]")) && !(value instanceof List)) throw new IllegalArgumentException("请输入 JSON 数组");
        if (type.equals("object") && !(value instanceof Map)) throw new IllegalArgumentException("请输入 JSON 对象");
        if (type.equals("number") && (value == null || value instanceof Boolean || value instanceof String || value instanceof Map || value instanceof List)) throw new IllegalArgumentException("请输入数字");
    }

    private void resetField(JSONObject field) {
        new AlertDialog.Builder(this).setTitle(t("恢复继承？")).setMessage(field.optString("key"))
                .setPositiveButton(t("恢复"), (dialog, which) -> {
                    try {
                        String original = store.read(project, "settings.json");
                        Map<String, Object> root = ConfigJson.object(original);
                        ConfigJson.set(root, field.optString("key"), null, true);
                        store.save(project, "settings.json", ConfigJson.encode(root), original); render();
                    } catch (Exception exception) { toast(exception.getMessage()); }
                }).setNegativeButton(t("取消"), null).show();
    }

    private void providers() throws Exception {
        if (getIntent().getBooleanExtra("pickModel", false)) {
            note(t("只更改当前会话的模型与思考强度。启动默认值仍在高级设置中管理。"));
            action(t("选择当前会话模型"), () -> catalog(false));
            return;
        }
        scope();
        note(t("服务商与凭据为全局配置；默认模型保存到当前所选范围。以下为自定义服务商。"));
        action(t("内置与自定义模型目录"), () -> catalog(false));
        action(t("联网刷新模型目录"), () -> catalog(true));
        Map<String, Object> root = ConfigJson.object(store.read(false, "models.json"));
        Object entries = root.get("providers");
        if (entries instanceof Map) for (Map.Entry<String, Object> entry : ConfigJson.asObject(entries).entrySet()) {
            String id = entry.getKey();
            if (!(entry.getValue() instanceof Map)) continue;
            Map<String, Object> provider = ConfigJson.asObject(entry.getValue());
            Object credential = ConfigJson.object(store.read(false, "auth.json")).get(id);
            boolean configured = credential instanceof Map && ConfigJson.asObject(credential).get("key") != null;
            link(String.valueOf(provider.getOrDefault("name", id)), id + " · " + (configured ? t("已存凭据") : t("未配置凭据"))
                    + "\n" + provider.getOrDefault("baseUrl", ""), () -> chooseModel(id, provider));
            LinearLayout actions = row(); content.addView(actions);
            actions.addView(button(configured ? t("更新 Key") : t("配置 Key"), () -> editCredential(id)));
            actions.addView(button(t("删除"), () -> deleteProvider(id)));
        }
        action(t("添加自定义服务商"), this::addProvider);
        link(t("配置凭据"), "auth.json", () -> { project = false; openFile("auth.json"); });
        link(t("编辑完整模型定义"), "models.json", () -> { project = false; openFile("models.json"); });
    }

    private void runQuery(String operation, JSONObject arguments, java.util.function.Consumer<Object> completed) {
        if (queryRunning) { toast(t("Pi 正在处理请求")); return; }
        final String snapshot;
        try { snapshot = store.snapshot(); } catch (Exception exception) { toast(exception.getMessage()); return; }
        int version = renderVersion;
        queryRunning = true;
        authUrl = ""; authInstructions = "";
        java.util.concurrent.atomic.AtomicBoolean cancelled = new java.util.concurrent.atomic.AtomicBoolean();
        android.app.ProgressDialog progress = android.app.ProgressDialog.show(this, "Pi", t("正在处理…"), true, true);
        queryProgress = progress;
        progress.setOnCancelListener(dialog -> {
            cancelled.set(true);
            if (queryBridge != null) queryBridge.abort(queryRequestId);
        });
        queries.execute(() -> {
            try {
                PiAgentBridge bridge = PiAgentBridge.get(this);
                queryBridge = bridge;
                Object[] result = {null}; String[] error = {""};
                queryRequestId = bridge.query(operation, snapshot, arguments, event -> runOnUiThread(() -> {
                    String type = event.optString("type");
                    if (type.equals("auth") && !isDestroyed()) showAuthNotice(event.optJSONObject("event"));
                    else if (type.equals("auth_prompt") && !isDestroyed()) showAuthPrompt(event);
                    else if (type.equals("auth_prompt_end")) {
                        AlertDialog dialog = authDialogs.remove(event.optString("promptId"));
                        if (dialog != null) dialog.dismiss();
                    } else if (type.equals("status") && !isDestroyed()) progress.setMessage(event.optString("message"));
                    else if (type.equals("result")) result[0] = event.opt("result");
                    else if (type.equals("error")) error[0] = event.optString("message");
                    else if (type.equals("end")) {
                        queryRunning = false; queryRequestId = null; queryBridge = null;
                        closeAuthDialogs();
                        if (isDestroyed()) return;
                        progress.dismiss();
                        if (cancelled.get() || version != renderVersion) return;
                        if (!error[0].isEmpty()) { toast(error[0]); return; }
                        try { completed.accept(result[0]); } catch (Exception exception) { toast(exception.getMessage()); }
                    }
                }));
                if (cancelled.get() || isDestroyed()) bridge.abort(queryRequestId);
            } catch (Exception exception) {
                runOnUiThread(() -> {
                    queryRunning = false; queryRequestId = null; queryBridge = null;
                    if (!isDestroyed()) { progress.dismiss(); if (!cancelled.get()) toast(exception.getMessage()); }
                });
            }
        });
    }

    private void closeAuthDialogs() {
        for (AlertDialog dialog : authDialogs.values()) dialog.dismiss();
        authDialogs.clear();
        if (authNotice != null) { authNotice.dismiss(); authNotice = null; }
    }

    private void openAuthUrl() {
        android.net.Uri uri = android.net.Uri.parse(authUrl);
        if (!"https".equalsIgnoreCase(uri.getScheme()) && !"http".equalsIgnoreCase(uri.getScheme())) { toast(t("登录地址必须是 HTTP 或 HTTPS")); return; }
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception exception) { toast(exception.getMessage()); }
    }

    private void showAuthNotice(JSONObject info) {
        String kind = info.optString("type");
        if (kind.equals("progress")) { if (queryProgress != null) queryProgress.setMessage(info.optString("message")); return; }
        if (kind.equals("auth_url")) authUrl = info.optString("url");
        if (kind.equals("device_code")) authUrl = info.optString("verificationUri");
        JSONArray links = info.optJSONArray("links");
        if (links != null && links.length() > 0) authUrl = links.optJSONObject(0).optString("url");
        authInstructions = info.optString("instructions", info.optString("message", ""));
        if (info.has("userCode")) authInstructions += t("\n验证码：") + info.optString("userCode");
        if (authNotice != null) authNotice.dismiss();
        TextView message = text(authInstructions + "\n" + authUrl, 16, INK);
        message.setPadding(dp(20), dp(12), dp(20), dp(12)); message.setTextIsSelectable(true);
        AlertDialog.Builder builder = new AlertDialog.Builder(this).setTitle(t("登录账号")).setView(message)
                .setNegativeButton(t("取消登录"), (d, w) -> { if (queryBridge != null) queryBridge.abort(queryRequestId); });
        if (!authUrl.isEmpty()) builder.setPositiveButton(t("打开登录页面"), (d, w) -> openAuthUrl());
        else builder.setPositiveButton(t("继续"), null);
        authNotice = builder.create(); authNotice.setCanceledOnTouchOutside(false); authNotice.show();
    }

    private void showAuthPrompt(JSONObject event) {
        if (authNotice != null) { authNotice.dismiss(); authNotice = null; }
        JSONObject prompt = event.optJSONObject("prompt");
        String token = event.optString("promptId");
        AlertDialog.Builder builder = new AlertDialog.Builder(this).setTitle(prompt.optString("message", "登录"))
                .setNegativeButton(t("取消"), (d, w) -> sendAuthReply(event, "", true));
        if (prompt.optString("type").equals("select")) {
            JSONArray options = prompt.optJSONArray("options"); String[] labels = new String[options.length()];
            for (int i = 0; i < labels.length; i++) labels[i] = options.optJSONObject(i).optString("label");
            builder.setItems(labels, (d, selected) -> sendAuthReply(event, options.optJSONObject(selected).optString("id"), false));
        } else {
            LinearLayout body = column(); body.setPadding(dp(20), dp(8), dp(20), 0);
            if (!authInstructions.isEmpty()) body.addView(text(authInstructions, 14, MUTED));
            EditText input = new EditText(this); input.setHint(prompt.optString("placeholder"));
            input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | (prompt.optString("type").equals("secret")
                    ? android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD : android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS));
            body.addView(input); builder.setView(body).setPositiveButton(t("继续"), (d, w) -> {
                sendAuthReply(event, input.getText().toString(), false); input.setText("");
            });
        }
        if (!authUrl.isEmpty()) builder.setNeutralButton(t("打开登录页"), null);
        AlertDialog dialog = builder.create(); dialog.setCanceledOnTouchOutside(false);
        dialog.setOnCancelListener(d -> sendAuthReply(event, "", true));
        dialog.setOnShowListener(d -> {
            if (!authUrl.isEmpty()) dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(v -> openAuthUrl());
        });
        authDialogs.put(token, dialog); dialog.show();
    }

    private void sendAuthReply(JSONObject event, String value, boolean cancelled) {
        try {
            PiAgentBridge bridge = queryBridge;
            if (bridge == null) throw new IllegalStateException(t("登录请求已结束"));
            bridge.replyAuth(event.optString("id"), event.optString("promptId"), value, cancelled);
        } catch (Exception exception) { toast(exception.getMessage()); }
    }

    private void catalog(boolean refresh) {
        JSONObject request = new JSONObject();
        try { request.put("refresh", refresh); } catch (Exception exception) { toast(exception.getMessage()); return; }
        runQuery("catalog", request, result -> {
            JSONArray providers = (JSONArray) result;
            String[] labels = new String[providers.length()];
            for (int i = 0; i < labels.length; i++) {
                JSONObject provider = providers.optJSONObject(i);
                labels[i] = provider.optString("name", provider.optString("id")) + " · " + provider.optJSONArray("models").length() + t(" 个模型");
            }
            new AlertDialog.Builder(this).setTitle(t("服务商目录")).setItems(labels, (dialog, which) -> {
                JSONObject provider = providers.optJSONObject(which);
                String id = provider.optString("id");
                new AlertDialog.Builder(this).setTitle(labels[which])
                        .setItems(new String[]{getIntent().getBooleanExtra("pickModel", false) ? t("选择当前会话模型") : t("选择默认模型"), t("配置 API Key"), t("账号登录"), t("退出账号"), t("发送测试请求（可能计费）")}, (d, action) -> {
                            if (action == 0) {
                                try { chooseModel(id, ConfigJson.object(provider.toString())); }
                                catch (Exception exception) { toast(exception.getMessage()); }
                            } else if (action == 1) editCredential(id);
                            else if (action == 2) loginProvider(provider);
                            else if (action == 3) new AlertDialog.Builder(this).setTitle(t("退出账号？"))
                                    .setMessage(t("清除应用内保存的凭据。服务商环境变量中的凭据不受影响。"))
                                    .setPositiveButton(t("退出"), (confirm, w) -> providerOperation(id, "logout", null))
                                    .setNegativeButton(t("取消"), null).show();
                            else {
                                JSONObject test = new JSONObject();
                                try { test.put("providerId", id); } catch (Exception exception) { toast(exception.getMessage()); return; }
                                runQuery("test_provider", test, value -> toast(t("请求成功 · ") + ((JSONObject) value).optString("model")));
                            }
                        }).setNegativeButton(t("取消"), null).show();
            }).setNegativeButton(t("关闭"), null).show();
        });
    }

    private void loginProvider(JSONObject provider) {
        JSONArray methods = provider.optJSONArray("authMethods");
        if (methods == null || methods.length() == 0) { toast(t("此服务商使用 API Key 或环境凭据，请选择配置 API Key")); return; }
        String[] labels = new String[methods.length()];
        for (int i = 0; i < labels.length; i++) labels[i] = "oauth".equals(methods.optString(i)) ? t("OAuth 登录") : t("服务商账号配置");
        new AlertDialog.Builder(this).setTitle(t("登录方式")).setItems(labels, (d, which) ->
                providerOperation(provider.optString("id"), "login", methods.optString(which))).setNegativeButton(t("取消"), null).show();
    }

    private void providerOperation(String id, String operation, String authType) {
        JSONObject arguments = new JSONObject();
        try { arguments.put("providerId", id); if (authType != null) arguments.put("authType", authType); }
        catch (Exception exception) { toast(exception.getMessage()); return; }
        runQuery(operation, arguments, result -> toast(operation.equals("login") ? t("登录完成") : t("已移除应用内凭据")));
    }

    private void installPackage() {
        EditText source = new EditText(this); source.setHint(t("npm:package / git:host/repo / 本地路径"));
        new AlertDialog.Builder(this).setTitle(project ? t("安装到工作区") : t("全局安装"))
                .setMessage(t("npm / Git 来源使用 Pi 的原生包管理器，需要运行环境中有对应命令。本地包使用应用可访问的路径。"))
                .setView(source).setPositiveButton(t("安装"), (d, w) -> packageOperation("install", source.getText().toString().trim(), project))
                .setNegativeButton(t("取消"), null).show();
    }

    private void packages() {
        runQuery("packages", new JSONObject(), result -> {
            JSONArray values = (JSONArray) result;
            packageSnapshot = values;
            if (values.length() == 0) { toast(t("没有已配置的包")); return; }
            String[] labels = new String[values.length()];
            for (int i = 0; i < labels.length; i++) {
                JSONObject item = values.optJSONObject(i);
                labels[i] = packageStatus(item);
            }
            new AlertDialog.Builder(this).setTitle(t("已配置的包")).setItems(labels, (d, which) -> {
                JSONObject item = values.optJSONObject(which); String source = item.optString("source");
                new AlertDialog.Builder(this).setTitle(source).setItems(new String[]{t("更新同来源包"), t("移除")}, (actions, action) -> {
                    if (action == 0) packageOperation("update", source, item.optString("scope").equals("project"));
                    else new AlertDialog.Builder(this).setTitle(t("移除包？")).setMessage(labels[which])
                            .setPositiveButton(t("移除"), (confirm, w) -> packageOperation("remove", source, item.optString("scope").equals("project")))
                            .setNegativeButton(t("取消"), null).show();
                }).setNegativeButton(t("取消"), null).show();
            }).setNegativeButton(t("关闭"), null).show();
        });
    }

    private void packageOperation(String operation, String source, boolean local) {
        JSONObject arguments = new JSONObject();
        try { arguments.put("source", source).put("project", local); }
        catch (Exception exception) { toast(exception.getMessage()); return; }
        runQuery(operation, arguments, result -> { packageSnapshot = null; toast(t("操作完成")); render(); });
    }

    private void resourceControls() {
        runQuery("resource_paths", new JSONObject(), result -> {
            JSONObject paths = (JSONObject) result;
            List<JSONObject> items = new ArrayList<>(); List<String> kinds = new ArrayList<>(); List<String> labels = new ArrayList<>();
            for (String kind : new String[]{"skills", "extensions", "prompts", "themes"}) {
                if (page.equals("技能") && !kind.equals("skills")) continue;
                if ((page.equals("扩展") || page.equals("MCP")) && !kind.equals("extensions")) continue;
                JSONArray values = paths.optJSONArray(kind);
                if (values == null) continue;
                for (int i = 0; i < values.length(); i++) {
                    JSONObject item = values.optJSONObject(i); items.add(item); kinds.add(kind);
                    JSONObject metadata = item.optJSONObject("metadata");
                    labels.add((item.optBoolean("enabled") ? t("已启用 · ") : t("已停用 · ")) + new java.io.File(item.optString("path")).getName()
                            + (metadata != null && metadata.optString("scope").equals("project") ? t(" · 工作区") : t(" · 全局")));
                }
            }
            if (items.isEmpty()) { toast(t("没有找到可管理的资源")); return; }
            new AlertDialog.Builder(this).setTitle(t("资源状态")).setItems(labels.toArray(new String[0]), (d, which) -> {
                JSONObject item = items.get(which);
                new AlertDialog.Builder(this).setTitle(new java.io.File(item.optString("path")).getName())
                        .setItems(new String[]{t("启用"), t("停用"), t("恢复默认")}, (options, selected) -> {
                            JSONObject arguments = new JSONObject();
                            try { arguments.put("kind", kinds.get(which)).put("path", item.optString("path"))
                                    .put("enabled", selected == 2 ? JSONObject.NULL : selected == 0); }
                            catch (Exception exception) { toast(exception.getMessage()); return; }
                            runQuery("resource_toggle", arguments, value -> { toast(t("资源配置已保存")); resourceControls(); });
                        }).setNegativeButton(t("取消"), null).show();
            }).setNegativeButton(t("关闭"), null).show();
        });
    }

    private void resources() {
        runQuery("resources", new JSONObject(), result -> {
            JSONObject resources = (JSONObject) result;
            StringBuilder info = new StringBuilder();
            String[] keys = {"skills", "prompts", "themes", "extensions"};
            String[] labels = {t("技能"), t("提示模板"), t("主题"), t("扩展")};
            for (int i = 0; i < keys.length; i++) {
                JSONObject group = resources.optJSONObject(keys[i]);
                JSONArray items = group == null ? resources.optJSONArray(keys[i]) : group.optJSONArray(keys[i]);
                info.append(labels[i]).append("\n");
                if (items == null || items.length() == 0) info.append(t("无\n"));
                else for (int j = 0; j < items.length(); j++) {
                    JSONObject item = items.optJSONObject(j);
                    info.append(item.optString("name", item.optString("path"))).append("\n");
                    if (item.has("filePath")) info.append(item.optString("filePath")).append("\n");
                    if (item.has("description")) info.append(item.optString("description")).append("\n");
                }
                if (group != null) info.append(t("诊断：")).append(group.opt("diagnostics")).append("\n");
                info.append("\n");
            }
            info.append(t("扩展错误：")).append(resources.opt("errors"));
            TextView text = text(info.toString(), 14, INK); text.setTextIsSelectable(true); text.setPadding(dp(20), dp(12), dp(20), dp(12));
            ScrollView scroll = new ScrollView(this); scroll.addView(text);
            new AlertDialog.Builder(this).setTitle(t("已加载资源")).setView(scroll).setPositiveButton(t("关闭"), null).show();
        });
    }

    private void chooseModel(String id, Map<String, Object> provider) {
        Object models = provider.get("models");
        List<String> ids = new ArrayList<>();
        if (models instanceof List) for (Object model : (List<?>) models) {
            if (model instanceof Map && ConfigJson.asObject(model).get("id") instanceof String) ids.add((String) ConfigJson.asObject(model).get("id"));
        }
        if (ids.isEmpty()) { toast(t("没有模型，请编辑 models.json")); return; }
        new AlertDialog.Builder(this).setTitle(id).setItems(ids.toArray(new String[0]), (dialog, which) -> {
            try {
                if (getIntent().getBooleanExtra("pickModel", false)) {
                    Map<String, Object> selected = ConfigJson.asObject(((List<?>) models).get(which));
                    Object available = selected.get("thinkingLevels");
                    if (!(available instanceof List)) throw new IllegalArgumentException(t("请从 SDK 模型目录选择模型"));
                    List<?> levels = (List<?>) available;
                    String[] choices = new String[levels.size() + 1]; choices[0] = t("继承默认强度");
                    for (int i = 0; i < levels.size(); i++) choices[i + 1] = String.valueOf(levels.get(i));
                    new AlertDialog.Builder(this).setTitle(t("当前会话思考强度")).setItems(choices, (d, strength) -> {
                        Intent result = new Intent().putExtra("provider", id).putExtra("model", ids.get(which));
                        if (strength > 0) result.putExtra("thinkingLevel", choices[strength]);
                        setResult(RESULT_OK, result); finish();
                    }).setNegativeButton(t("取消"), null).show();
                    return;
                }
                String original = store.read(project, "settings.json");
                Map<String, Object> settings = ConfigJson.object(original);
                settings.put("defaultProvider", id); settings.put("defaultModel", ids.get(which));
                store.save(project, "settings.json", ConfigJson.encode(settings), original);
                toast(t("已保存默认模型，下次 Pi 发送生效"));
            } catch (Exception exception) { toast(exception.getMessage()); }
        }).setNegativeButton(t("取消"), null).show();
    }

    private void addProvider() {
        final String original;
        try { original = store.read(false, "models.json"); } catch (Exception exception) { toast(exception.getMessage()); return; }
        LinearLayout body = column(); body.setPadding(dp(20), 0, dp(20), 0);
        String[] names = {"ID", t("显示名（可选）"), "Base URL", t("API 协议"), t("模型 ID（每行一个）"), t("API Key（可选）")};
        EditText[] inputs = new EditText[names.length];
        for (int i = 0; i < names.length; i++) { inputs[i] = new EditText(this); inputs[i].setHint(names[i]); inputs[i].setContentDescription(names[i]); body.addView(inputs[i]); }
        inputs[3].setText("openai-completions");
        inputs[5].setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD);
        TextView error = text(t("配置保存到 models.json；API Key 单独保存在 auth.json。"), 14, MUTED); body.addView(error);
        ScrollView scroll = new ScrollView(this); scroll.addView(body);
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle(t("添加服务商")).setView(scroll).setPositiveButton(t("保存"), null).setNegativeButton(t("取消"), null).create();
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            try {
                String id = inputs[0].getText().toString().trim();
                if (!id.matches("[A-Za-z0-9][A-Za-z0-9_-]*")) throw new IllegalArgumentException(t("ID 只能包含字母、数字、下划线与连字符"));
                String base = ProviderConfig.validateBaseUrl(inputs[2].getText().toString());
                String api = inputs[3].getText().toString().trim();
                if (api.isEmpty()) throw new IllegalArgumentException(t("API 协议不能为空"));
                List<Object> models = new ArrayList<>();
                for (String modelId : inputs[4].getText().toString().split("[,\\n]")) if (!modelId.trim().isEmpty()) {
                    Map<String, Object> model = new LinkedHashMap<>(); model.put("id", modelId.trim()); models.add(model);
                }
                if (models.isEmpty()) throw new IllegalArgumentException(t("至少添加一个模型 ID"));
                Map<String, Object> root = ConfigJson.object(original);
                Object current = root.get("providers");
                if (current != null && !(current instanceof Map)) throw new IllegalArgumentException(t("providers 必须是对象"));
                Map<String, Object> providers = current == null ? new LinkedHashMap<>() : ConfigJson.asObject(current);
                if (providers.containsKey(id)) throw new IllegalArgumentException(t("该 ID 已存在，请编辑原服务商"));
                Map<String, Object> provider = new LinkedHashMap<>();
                provider.put("baseUrl", base); provider.put("api", api); provider.put("models", models);
                String name = inputs[1].getText().toString().trim(); if (!name.isEmpty()) provider.put("name", name);
                providers.put(id, provider); root.put("providers", providers);
                String key = inputs[5].getText().toString().trim();
                Map<String, String> updates = new LinkedHashMap<>(), originals = new LinkedHashMap<>();
                updates.put("models.json", ConfigJson.encode(root)); originals.put("models.json", original);
                if (!key.isEmpty()) {
                    String oldAuth = store.read(false, "auth.json");
                    Map<String, Object> auth = ConfigJson.object(oldAuth);
                    Map<String, Object> credential = new LinkedHashMap<>(); credential.put("type", "api_key"); credential.put("key", key);
                    auth.put(id, credential); updates.put("auth.json", ConfigJson.encode(auth)); originals.put("auth.json", oldAuth);
                }
                store.saveTogether(updates, originals);
                dialog.dismiss(); render();
            } catch (Exception exception) { error.setText(exception.getMessage()); error.setTextColor(Color.RED); }
        }));
        dialog.show();
    }

    private void editCredential(String id) {
        try {
            String original = store.read(false, "auth.json");
            Map<String, Object> auth = ConfigJson.object(original);
            LinearLayout body = column(); body.setPadding(dp(20), dp(8), dp(20), 0);
            body.addView(text("API Key · " + id, 16, INK));
            EditText key = new EditText(this);
            key.setHint(t("输入新的 API Key"));
            key.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD);
            body.addView(key);
            TextView error = text(t("密钥保存于应用私有 auth.json，不回填到输入框。"), 13, MUTED); body.addView(error);
            AlertDialog dialog = new AlertDialog.Builder(this).setTitle(t("配置凭据")).setView(body)
                    .setPositiveButton(t("保存"), null).setNegativeButton(t("取消"), null).setNeutralButton(t("移除凭据"), null).create();
            dialog.setOnShowListener(ignored -> {
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
                    try {
                        String value = key.getText().toString().trim();
                        if (value.isEmpty()) throw new IllegalArgumentException(t("API Key 不能为空"));
                        Map<String, Object> next = new LinkedHashMap<>();
                        Object existing = auth.get(id);
                        if (existing instanceof Map && ConfigJson.asObject(existing).get("env") != null) next.put("env", ConfigJson.asObject(existing).get("env"));
                        next.put("type", "api_key"); next.put("key", value); auth.put(id, next);
                        store.save(false, "auth.json", ConfigJson.encode(auth), original);
                        key.setText(""); dialog.dismiss(); render();
                    } catch (Exception exception) { error.setText(exception.getMessage()); }
                });
                dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(view -> new AlertDialog.Builder(this)
                        .setTitle(t("移除 ") + id + t(" 的凭据？")).setPositiveButton(t("移除"), (d, w) -> {
                            try { auth.remove(id); store.save(false, "auth.json", ConfigJson.encode(auth), original); dialog.dismiss(); render(); }
                            catch (Exception exception) { error.setText(exception.getMessage()); }
                        }).setNegativeButton(t("取消"), null).show());
            });
            dialog.show();
        } catch (Exception exception) { toast(exception.getMessage()); }
    }

    private void deleteProvider(String id) {
        new AlertDialog.Builder(this).setTitle(t("删除服务商？")).setMessage(t("将移除 ") + id + t(" 的自定义模型和已保存凭据。"))
                .setPositiveButton(t("删除"), (dialog, which) -> {
                    try {
                        Map<String, String> updates = new LinkedHashMap<>(), originals = new LinkedHashMap<>();
                        String modelsText = store.read(false, "models.json"), authText = store.read(false, "auth.json");
                        Map<String, Object> models = ConfigJson.object(modelsText), auth = ConfigJson.object(authText);
                        Object providers = models.get("providers");
                        if (providers instanceof Map) ConfigJson.asObject(providers).remove(id);
                        auth.remove(id);
                        originals.put("models.json", modelsText); originals.put("auth.json", authText);
                        updates.put("models.json", ConfigJson.encode(models)); updates.put("auth.json", ConfigJson.encode(auth));
                        store.saveTogether(updates, originals); render();
                    } catch (Exception exception) { toast(exception.getMessage()); }
                }).setNegativeButton(t("取消"), null).show();
    }

    private void openFile(String name) {
        if (name.equals("auth.json")) new AlertDialog.Builder(this).setTitle(t("打开凭据文件"))
                .setMessage(t("文件可能含 API Key。内容仅在本应用私有目录保存，导出时也会包含密钥。"))
                .setPositiveButton(t("打开"), (dialog, which) -> go("file:" + name)).setNegativeButton(t("取消"), null).show();
        else go("file:" + name);
    }

    private void fileEditor(String name) throws Exception {
        fileName = name;
        expected = store.read(project, name);
        cleanBuffer = expected;
        boolean json = name.endsWith(".json");
        String openingError = null;
        if (json) try { cleanBuffer = ConfigJson.format(expected); } catch (Exception exception) { openingError = exception.getMessage(); }
        note((project ? t("工作区 / ") : t("全局 / ")) + name);
        note(json ? t("打开与保存时自动格式化为两空格缩进。输入期间保持光标位置；JSON 不接受注释。") : t("纯文本文件，不进行 JSON 格式化。"));
        LinearLayout actions = row(); content.addView(actions);
        if (json) actions.addView(button(t("格式化"), this::formatEditor));
        actions.addView(button(t("导入"), () -> startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE), 1)));
        actions.addView(button(t("导出"), () -> {
            exportText = editor.getText().toString();
            startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).setType(json ? "application/json" : "text/plain")
                    .addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE, new java.io.File(name).getName()), 2);
        }));
        editor = new EditText(this); editor.setGravity(Gravity.TOP); editor.setTypeface(Typeface.MONOSPACE);
        editor.setTextSize(14); editor.setTextColor(INK); editor.setMinLines(12);
        editor.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE | android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        editor.setContentDescription(name + t(" 编辑器"));
        editor.setText(getPreferences(MODE_PRIVATE).getString(draftKey(), cleanBuffer));
        if (getPreferences(MODE_PRIVATE).contains(draftKey())) expected = getPreferences(MODE_PRIVATE).getString(draftKey() + "/base", expected);
        content.addView(editor, new LinearLayout.LayoutParams(-1, -2));
        status = text(openingError == null ? (dirty() ? t("已恢复未保存草稿") : t("已自动格式化，文件尚未改写")) : openingError, 14, MUTED);
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); content.addView(status);
        editor.addTextChangedListener(watcher(() -> { if (!updatingEditor) status.setText(t("尚未保存")); }));
        LinearLayout bottom = row(); bottom.setPadding(dp(16), dp(8), dp(16), dp(8));
        bottom.addView(button(t("恢复上一版"), () -> {
            try { editor.setText(store.previous(project, name)); status.setText(t("已载入上一版，请确认后保存")); }
            catch (Exception exception) { status.setText(exception.getMessage()); }
        }), new LinearLayout.LayoutParams(0, -2, 1));
        bottom.addView(button(t("保存"), this::saveEditor), new LinearLayout.LayoutParams(0, -2, 1));
        shell.addView(bottom);
    }

    private void formatEditor() {
        try {
            String formatted = ConfigJson.format(editor.getText().toString());
            updatingEditor = true; editor.setText(formatted); editor.setSelection(0); updatingEditor = false;
            status.setTextColor(MUTED);
            status.setText(t("格式化完成，尚未保存"));
        } catch (Exception exception) { editorError(exception); }
    }

    private void saveEditor() {
        try {
            String source = editor.getText().toString();
            String formatted = fileName.endsWith(".json") ? ConfigJson.format(source) : source;
            store.save(project, fileName, formatted, expected);
            expected = formatted; cleanBuffer = formatted;
            updatingEditor = true; editor.setText(formatted); updatingEditor = false;
            clearDraft();
            status.setTextColor(TEAL);
            status.setText(t("已保存。下一次 Pi 请求读取；终端专用设置不改变 Android 界面。"));
        } catch (Exception exception) { editorError(exception); }
    }

    private void editorError(Exception exception) {
        updatingEditor = false;
        status.setText(t("未保存：") + exception.getMessage()); status.setTextColor(appearance.error);
        java.util.regex.Matcher match = java.util.regex.Pattern.compile("line (\\d+) column (\\d+)").matcher(String.valueOf(exception.getMessage()));
        if (match.find()) {
            int line = Integer.parseInt(match.group(1)), column = Integer.parseInt(match.group(2));
            String text = editor.getText().toString(); int offset = 0;
            for (int i = 1; i < line && offset < text.length(); i++) { int next = text.indexOf('\n', offset); offset = next < 0 ? text.length() : next + 1; }
            editor.setSelection(Math.min(text.length(), offset + Math.max(0, column - 1))); editor.requestFocus();
        }
        retainDraft();
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (result != RESULT_OK || data == null || data.getData() == null) return;
        if (request == 3) { importBackgroundImage(data.getData()); return; }
        if (editor == null) return;
        try {
            if (request == 1) {
                try (InputStream input = getContentResolver().openInputStream(data.getData())) {
                    String imported = readText(input);
                    if (fileName.endsWith(".json")) imported = ConfigJson.format(imported);
                    editor.setText(imported); status.setText(t("已导入编辑区，请确认后保存"));
                }
            } else if (request == 2) {
                try (java.io.OutputStream output = getContentResolver().openOutputStream(data.getData(), "wt")) {
                    if (output == null) throw new java.io.IOException(t("无法打开导出文件"));
                    output.write((exportText == null ? editor.getText().toString() : exportText).getBytes(StandardCharsets.UTF_8));
                    toast(t("已导出"));
                }
            }
        } catch (Exception exception) { editorError(exception); }
    }

    private String readText(InputStream input) throws Exception {
        if (input == null) throw new java.io.IOException(t("无法打开文件"));
        ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] buffer = new byte[8192];
        for (int count; (count = input.read(buffer)) != -1;) {
            if (output.size() + count > ConfigJson.MAX_LENGTH * 4) throw new java.io.IOException(t("文件过大"));
            output.write(buffer, 0, count);
        }
        return output.toString("UTF-8");
    }

    private TextWatcher watcher(Runnable changed) {
        return new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            public void onTextChanged(CharSequence s, int start, int before, int count) { changed.run(); }
            public void afterTextChanged(Editable value) { }
        };
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private LinearLayout column() { LinearLayout view = new LinearLayout(this); view.setOrientation(LinearLayout.VERTICAL); return view; }
    private LinearLayout row() { LinearLayout view = new LinearLayout(this); view.setGravity(Gravity.CENTER_VERTICAL); return view; }
    private TextView text(String value, int size, int color) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(color); return view;
    }
    private void note(String value) { TextView view = text(value, 14, MUTED); view.setPadding(0, dp(12), 0, dp(12)); content.addView(view); }
    private Button button(String label, Runnable click) {
        Button button = new Button(this); button.setText(label); button.setTextColor(TEAL); button.setTextSize(15); button.setAllCaps(false); button.setMinHeight(dp(48)); button.setOnClickListener(view -> click.run()); return button;
    }
    private void action(String label, Runnable click) { content.addView(button(label, click), new LinearLayout.LayoutParams(-1, -2)); }
    private LinearLayout link(String label, String summary, Runnable click) {
        LinearLayout item = column(); item.setPadding(dp(16), dp(14), dp(16), dp(14)); item.setMinimumHeight(dp(56));
        GradientDrawable background = new GradientDrawable(); background.setColor(appearance.surface); background.setCornerRadius(dp(12)); item.setBackground(background);
        item.addView(text(label + "  ›", 16, INK));
        if (!summary.isEmpty()) { TextView detail = text(summary, 13, MUTED); detail.setPadding(0, dp(5), 0, 0); item.addView(detail); }
        item.setFocusable(true); item.setClickable(true); item.setOnClickListener(view -> click.run());
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.bottomMargin = dp(6); content.addView(item, params); return item;
    }
    private EditText input(String hint, String value) { EditText input = new EditText(this); input.setHint(hint); input.setContentDescription(hint); input.setText(value); content.addView(input); return input; }
    private void toast(String message) { Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }
}
