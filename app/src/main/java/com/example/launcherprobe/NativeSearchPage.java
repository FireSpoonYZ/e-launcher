package com.example.launcherprobe;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.os.OperationCanceledException;
import android.provider.Settings;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.VelocityTracker;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.widget.BaseAdapter;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Full-screen native app library/local search. The host supplies navigation, never a Dock. */
public final class NativeSearchPage extends FrameLayout {
    public enum Mode { APP_LIBRARY, GLOBAL_SEARCH }
    public static final String DRAG_MIME = "application/vnd.launcherprobe.desktop-item";

    /** Local drag state; the desktop commits placement and pins shortcuts only after a successful drop. */
    public record DragItem(ComponentName component, String shortcutId, long userSerial, String label) { }

    public interface Host {
        void showDesktop();
        /** Must create, submit through ChatCoordinator, and open the existing chat; not a draft action. */
        void sendToAssistant(String prompt);
        /** destination is desktop/grid/layout/dock/search/folders/widgets/gestures/wallpaper/icons/theme/backup/assistant. */
        void openSettings(String destination);
        /** Called after startDragAndDrop succeeds. Reveal the desktop without ending the drag. */
        void onDragStarted(DragItem item);
    }

    public static final int DIRECTORY_REQUEST = 7318;
    private final Activity activity;
    private final Host host;
    private final Mode mode;
    private final AppAppearance colors;
    private final EditText input;
    private final ListView list;
    private final LinearLayout alphabet;
    private final RowAdapter adapter = new RowAdapter();
    private final ArrayList<Row> rows = new ArrayList<>();
    private final Map<String, Integer> sectionPositions = new LinkedHashMap<>();
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private CancellationSignal cancellation;
    private LauncherSearchIndex index;
    private int generation;
    private int filter;
    private boolean disposed;
    private final Runnable query = this::search;
    private final int touchSlop;
    private final float minimumFlingVelocity;
    private float closeDownY;
    private boolean closing;
    private boolean closeFromHeader;
    private VelocityTracker closeVelocity;

    public NativeSearchPage(Activity activity, Mode mode, String initialQuery, Host host) {
        super(activity);
        this.activity = activity;
        this.mode = mode;
        this.host = host;
        colors = AppAppearance.readDesktop(activity);
        ViewConfiguration configuration = ViewConfiguration.get(activity);
        touchSlop = configuration.getScaledTouchSlop();
        minimumFlingVelocity = Math.max(configuration.getScaledMinimumFlingVelocity(),
                600 * getResources().getDisplayMetrics().density);
        View wallpaper = colors.desktopWallpaper(activity);
        addView(wallpaper, new LayoutParams(-1, -1));
        setFocusableInTouchMode(true);
        setClickable(true);
        LinearLayout content = column();
        content.setPadding(dp(18), dp(14), dp(18), dp(8));
        addView(content, new LayoutParams(-1, -1));
        if (mode == Mode.APP_LIBRARY) {
            LinearLayout title = line();
            TextView heading = text("应用库", 25, colors.ink);
            heading.setTypeface(null, android.graphics.Typeface.BOLD);
            title.addView(heading, new LinearLayout.LayoutParams(0, dp(48), 1));
            heading.setGravity(Gravity.CENTER_VERTICAL);
            ImageView more = symbol("more", colors.ink); more.setRotation(90);
            more.setPadding(dp(13), dp(13), dp(13), dp(13));
            more.setContentDescription("应用库选项"); more.setFocusable(true);
            more.setOnClickListener(v -> libraryOptions());
            title.addView(more, new LinearLayout.LayoutParams(dp(48), dp(48))); content.addView(title);
        }
        LinearLayout searchRow = line();
        FrameLayout searchGlass = new FrameLayout(activity); searchGlass.setBackground(panel(false));
        LinearLayout searchBar = line(); searchBar.setPadding(dp(12), 0, 0, 0);
        ImageView magnifier = symbol("search", colors.muted);
        magnifier.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        searchBar.addView(magnifier, new LinearLayout.LayoutParams(dp(22), dp(22)));
        input = new EditText(activity); input.setSingleLine(true);
        input.setTextColor(colors.ink); input.setHintTextColor(colors.muted); input.setTextSize(16);
        input.setHint(mode == Mode.APP_LIBRARY ? "搜索应用" : "搜索应用、快捷方式、设置与文件");
        input.setBackgroundColor(android.graphics.Color.TRANSPARENT);
        input.setPadding(dp(10), 0, 0, 0);
        input.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH);
        searchBar.addView(input, new LinearLayout.LayoutParams(0, dp(48), 1));
        ImageView clear = symbol("close", colors.muted); clear.setPadding(dp(15), dp(15), dp(15), dp(15));
        clear.setContentDescription("清空搜索"); clear.setFocusable(true); clear.setOnClickListener(v -> input.setText(""));
        clear.setVisibility(initialQuery == null || initialQuery.isEmpty() ? INVISIBLE : VISIBLE);
        searchBar.addView(clear, new LinearLayout.LayoutParams(dp(48), dp(48)));
        searchGlass.addView(searchBar, new LayoutParams(-1, -1));
        searchRow.addView(searchGlass, new LinearLayout.LayoutParams(0, dp(48), 1));
        if (mode == Mode.GLOBAL_SEARCH) searchRow.addView(action("取消", v -> close()));
        LinearLayout.LayoutParams searchParams = new LinearLayout.LayoutParams(-1, dp(48));
        searchParams.topMargin = mode == Mode.APP_LIBRARY ? dp(10) : 0;
        searchParams.bottomMargin = dp(10); content.addView(searchRow, searchParams);
        LinearLayout results = line();
        results.setGravity(Gravity.TOP);
        results.setBaselineAligned(false);
        list = new ListView(activity);
        list.setDivider(null);
        list.setVerticalScrollBarEnabled(false);
        list.setClipToPadding(false);
        list.setPadding(0, 0, 0, dp(16));
        list.setAdapter(adapter);
        list.setBackgroundColor(android.graphics.Color.TRANSPARENT);
        results.addView(list, new LinearLayout.LayoutParams(0, -1, 1));
        alphabet = new LinearLayout(activity) {
            @Override protected void onMeasure(int widthSpec, int heightSpec) {
                super.onMeasure(widthSpec, MeasureSpec.makeMeasureSpec(Math.min(dp(440), MeasureSpec.getSize(heightSpec)), MeasureSpec.EXACTLY));
            }
        };
        alphabet.setOrientation(LinearLayout.VERTICAL); alphabet.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams alphabetParams = new LinearLayout.LayoutParams(dp(22), -1);
        alphabetParams.gravity = Gravity.BOTTOM; results.addView(alphabet, alphabetParams);
        list.setOnScrollListener(new android.widget.AbsListView.OnScrollListener() {
            public void onScrollStateChanged(android.widget.AbsListView view, int state) { }
            public void onScroll(android.widget.AbsListView view, int first, int visible, int total) {
                if (sectionPositions.isEmpty()) return;
                String selected = sectionPositions.keySet().iterator().next();
                for (Map.Entry<String, Integer> section : sectionPositions.entrySet()) {
                    if (section.getValue() > first) break;
                    selected = section.getKey();
                }
                for (int i = 0; i < alphabet.getChildCount(); i++) {
                    TextView letter = (TextView) alphabet.getChildAt(i);
                    boolean active = selected.contentEquals(letter.getText());
                    letter.setTextColor(active ? colors.ink : colors.muted);
                    letter.setBackground(active ? panel(true) : null);
                }
            }
        });
        content.addView(results, new LinearLayout.LayoutParams(-1, 0, 1));
        input.setText(initialQuery == null ? "" : initialQuery);
        input.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) {
                clear.setVisibility(s.length() == 0 ? INVISIBLE : VISIBLE);
                cancelSearch();
                renderImmediate();
                main.removeCallbacks(query);
                main.postDelayed(query, 120);
            }
            @Override public void afterTextChanged(Editable value) { }
        });
        // The IME search key never sends to AI; only the explicit first result does.
        input.setOnEditorActionListener((v, action, event) -> { search(); return true; });
        requestFocus();
    }

    @Override protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        refresh();
        post(() -> {
            if (disposed || !isAttachedToWindow()) return;
            if (mode == Mode.GLOBAL_SEARCH) {
                input.requestFocus();
                input.setSelection(input.length());
                input.postDelayed(() -> {
                    if (isAttachedToWindow() && input.hasFocus()) keyboard().showSoftInput(input, InputMethodManager.SHOW_IMPLICIT);
                }, 180);
            } else { requestFocus(); keyboard().hideSoftInputFromWindow(getWindowToken(), 0); }
        });
    }

    @Override public boolean dispatchTouchEvent(MotionEvent event) {
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
            for (android.view.ViewParent parent = getParent(); parent != null; parent = parent.getParent()) {
                parent.requestDisallowInterceptTouchEvent(true);
                if (parent instanceof PagerRoot pager) pager.setGestureBlocked(pager.gestureId(), true);
            }
            closeDownY = event.getY();
            closing = false;
            closeFromHeader = !onList(event);
            recycleCloseVelocity();
            closeVelocity = VelocityTracker.obtain();
            closeVelocity.addMovement(event);
        } else if (closeVelocity != null) closeVelocity.addMovement(event);
        if (!closing && action == MotionEvent.ACTION_MOVE) {
            float dy = event.getY() - closeDownY;
            boolean pull = mode == Mode.APP_LIBRARY ? dy > touchSlop : dy < -touchSlop;
            if (pull && (closeFromHeader || canDismiss())) {
                closing = true;
                MotionEvent cancel = MotionEvent.obtain(event);
                cancel.setAction(MotionEvent.ACTION_CANCEL);
                super.dispatchTouchEvent(cancel);
                cancel.recycle();
            }
        }
        if (closing) {
            if (action == MotionEvent.ACTION_MOVE) {
                float dy = event.getY() - closeDownY;
                setTranslationY(mode == Mode.APP_LIBRARY ? Math.max(0, dy) : Math.min(0, dy));
                return true;
            }
            if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
                float velocityY = 0;
                if (closeVelocity != null) {
                    closeVelocity.computeCurrentVelocity(1000);
                    velocityY = closeVelocity.getYVelocity();
                }
                recycleCloseVelocity();
                float progress = Math.abs(getTranslationY()) / Math.max(1, getHeight());
                boolean dismiss = action != MotionEvent.ACTION_CANCEL
                        && Motion.crossed(progress, mode == Mode.APP_LIBRARY ? velocityY : -velocityY,
                        minimumFlingVelocity, false);
                closing = false;
                if (dismiss) host.showDesktop();
                else Motion.spring(this, androidx.dynamicanimation.animation.DynamicAnimation.TRANSLATION_Y,
                        0, velocityY, null);
                return true;
            }
            return true;
        }
        return super.dispatchTouchEvent(event);
    }

    @Override public void requestDisallowInterceptTouchEvent(boolean disallowIntercept) {
        if (disallowIntercept && (closeFromHeader || canDismiss())) return;
        super.requestDisallowInterceptTouchEvent(disallowIntercept);
    }

    @Override protected void onDetachedFromWindow() {
        cancelSearch();
        main.removeCallbacks(query);
        super.onDetachedFromWindow();
    }

    /** Call after installed apps/shortcut permissions change or when returning from an app. */
    public void refresh() {
        if (disposed) return;
        cancelSearch();
        renderImmediate();
        CancellationSignal signal = cancellation = new CancellationSignal();
        int version = generation;
        worker.execute(() -> {
            try {
                LauncherSearchIndex next = new LauncherSearchIndex(activity, signal);
                main.post(() -> {
                    if (!valid(version)) return;
                    index = next;
                    search();
                });
            } catch (OperationCanceledException ignored) { }
            catch (RuntimeException failure) { postFailure(version, "无法读取应用列表，请重试"); }
        });
    }

    /** Release when the host permanently removes this page. */
    public void dispose() {
        keyboard().hideSoftInputFromWindow(input.getWindowToken(), 0);
        disposed = true;
        recycleCloseVelocity();
        cancelSearch();
        main.removeCallbacksAndMessages(null);
        worker.shutdownNow();
    }

    private void close() {
        keyboard().hideSoftInputFromWindow(input.getWindowToken(), 0);
        host.showDesktop();
    }

    @Override public boolean onInterceptTouchEvent(MotionEvent event) {
        return closing || super.onInterceptTouchEvent(event);
    }

    @Override public boolean onTouchEvent(MotionEvent event) {
        if (!closing) return super.onTouchEvent(event);
        if (closeVelocity != null) closeVelocity.addMovement(event);
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_MOVE:
                float dy = event.getY() - closeDownY;
                if (mode == Mode.APP_LIBRARY) setTranslationY(Math.max(0, dy));
                else setTranslationY(Math.min(0, dy));
                return true;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                float velocityY = 0;
                if (closeVelocity != null) {
                    closeVelocity.computeCurrentVelocity(1000);
                    velocityY = closeVelocity.getYVelocity();
                }
                recycleCloseVelocity();
                float progress = Math.abs(getTranslationY()) / Math.max(1, getHeight());
                boolean dismiss = event.getActionMasked() != MotionEvent.ACTION_CANCEL
                        && Motion.crossed(progress, mode == Mode.APP_LIBRARY ? velocityY : -velocityY,
                        minimumFlingVelocity, false);
                closing = false;
                if (dismiss) host.showDesktop();
                else Motion.spring(this, androidx.dynamicanimation.animation.DynamicAnimation.TRANSLATION_Y,
                        0, velocityY, null);
                return true;
            default:
                return true;
        }
    }

    private boolean canDismiss() {
        return mode == Mode.APP_LIBRARY ? !listCanScrollTowardStart() : !listCanScrollTowardEnd();
    }

    private boolean listCanScrollTowardStart() {
        if (list.getHeight() <= 0 || list.getChildCount() == 0) return false;
        if (list.getFirstVisiblePosition() > 0) return true;
        View first = list.getChildAt(0);
        return first != null && first.getTop() < list.getPaddingTop() - touchSlop;
    }

    private boolean listCanScrollTowardEnd() {
        if (list.getHeight() <= 0 || list.getChildCount() == 0) return false;
        if (list.getLastVisiblePosition() < list.getCount() - 1) return true;
        View last = list.getChildAt(list.getChildCount() - 1);
        return last != null && last.getBottom() > list.getHeight() - list.getPaddingBottom() + touchSlop;
    }

    private boolean onList(MotionEvent event) {
        if (list.getWidth() <= 0 || list.getHeight() <= 0) return false;
        Rect bounds = new Rect(0, 0, list.getWidth(), list.getHeight());
        offsetDescendantRectToMyCoords(list, bounds);
        return bounds.contains((int) event.getX(), (int) event.getY());
    }

    private void recycleCloseVelocity() {
        if (closeVelocity != null) closeVelocity.recycle();
        closeVelocity = null;
    }

    private void search() {
        if (disposed) return;
        if (index == null) { refresh(); return; }
        cancelSearch();
        String value = input.getText().toString().trim();
        renderImmediate();
        int version = generation;
        CancellationSignal signal = cancellation = new CancellationSignal();
        LauncherSearchIndex source = index;
        worker.execute(() -> {
            try {
                LauncherSearchIndex.Result result = source.search(value, mode == Mode.GLOBAL_SEARCH, signal,
                        partial -> main.post(() -> { if (valid(version)) render(partial); }));
                main.post(() -> { if (valid(version)) render(result); });
            } catch (OperationCanceledException ignored) { }
            catch (RuntimeException failure) { postFailure(version, "搜索暂不可用，请重新输入或重试"); }
        });
    }

    private void cancelSearch() {
        generation++;
        if (cancellation != null) cancellation.cancel();
    }

    private boolean valid(int version) { return !disposed && generation == version && isAttachedToWindow(); }

    private void postFailure(int version, String message) {
        main.post(() -> {
            if (!valid(version)) return;
            rows.add(new Row(message, null, null, false));
            rows.add(new Row("重试", null, this::refresh, false));
            notifyRows();
        });
    }

    private void renderImmediate() {
        rows.clear();
        sectionPositions.clear();
        alphabet.removeAllViews();
        alphabet.setVisibility(GONE);
        String value = input.getText().toString().trim();
        if (mode == Mode.GLOBAL_SEARCH) {
            if (!value.isEmpty()) {
                header("AI 助手");
                rows.add(new Row("发送给 AI 助手：" + value, null, () -> {
                    String prompt = input.getText().toString().trim();
                    if (prompt.isEmpty()) return;
                    keyboard().hideSoftInputFromWindow(input.getWindowToken(), 0);
                    host.sendToAssistant(prompt);
                }, true));
            } else {
                rows.add(new Row("输入关键词，搜索本机内容或发送给 AI 助手", null, null, false));
                rows.add(new Row("授权文件夹以搜索文件名", null, this::authorizeDirectory, false));
            }
        }
        notifyRows();
    }

    private void render(LauncherSearchIndex.Result result) {
        renderImmediate();
        String value = input.getText().toString().trim();
        if (mode == Mode.APP_LIBRARY) {
            ArrayList<LauncherSearchIndex.App> apps = new ArrayList<>(result.apps());
            if (filter == 1) {
                apps.removeIf(app -> app.launched() == 0);
                apps.sort(Comparator.comparingLong(LauncherSearchIndex.App::launched).reversed());
                header("最近使用 · 本桌面启动记录");
                appGrid(apps);
            } else if (filter == 2) {
                apps.sort(Comparator.comparingLong(LauncherSearchIndex.App::installed).reversed());
                header("最近安装");
                appGrid(apps);
            } else {
                if (value.isEmpty()) {
                    List<LauncherSearchIndex.App> recent = apps.stream().filter(app -> app.launched() > 0)
                            .sorted(Comparator.comparingLong(LauncherSearchIndex.App::launched).reversed()).limit(4)
                            .collect(java.util.stream.Collectors.toList());
                    header("最近使用");
                    if (recent.isEmpty()) rows.add(new Row("从本桌面打开应用后显示在这里", null, null, false));
                    else appGrid(recent);
                }
                header(value.isEmpty() ? "全部应用" : "应用搜索结果");
                LinkedHashMap<String, List<LauncherSearchIndex.App>> groups = new LinkedHashMap<>();
                for (LauncherSearchIndex.App app : apps)
                    groups.computeIfAbsent(app.name().section(), ignored -> new ArrayList<>()).add(app);
                for (Map.Entry<String, List<LauncherSearchIndex.App>> entry : groups.entrySet()) {
                    sectionPositions.put(entry.getKey(), rows.size());
                    List<LauncherSearchIndex.App> group = entry.getValue();
                    for (int i = 0; i < group.size(); i += 3) {
                        Row row = new Row(null, group.subList(i, Math.min(i + 3, group.size())), null, false);
                        row.grouped = true; row.section = i == 0 ? entry.getKey() : ""; rows.add(row);
                    }
                }
                buildAlphabet();
            }
            if (apps.isEmpty()) rows.add(new Row(filter == 1 ? "暂无真实启动记录" : "没有匹配的应用", null, null, false));
        } else if (!value.isEmpty()) {
            header("应用");
            for (LauncherSearchIndex.App app : result.apps()) rows.add(new Row(app.label(), List.of(app), () -> launch(app), false));
            if (result.apps().isEmpty()) rows.add(new Row("没有匹配的应用", null, null, false));
            header("快捷方式");
            for (LauncherSearchIndex.Shortcut shortcut : result.shortcuts()) {
                Row row = new Row(shortcut.label(), null, () -> launch(shortcut), false);
                row.shortcut = shortcut;
                rows.add(row);
            }
            if (!result.shortcutNotice().isEmpty()) rows.add(new Row(result.shortcutNotice(), null,
                    () -> open(new Intent(Settings.ACTION_HOME_SETTINGS)), false));
            else if (result.shortcuts().isEmpty()) rows.add(new Row("没有匹配的快捷方式", null, null, false));
            header("设置");
            for (LauncherSearchIndex.Setting setting : result.settings())
                rows.add(new Row(setting.label(), null, () -> {
                    if (setting.intent() != null) open(setting.intent());
                    else host.openSettings(setting.destination());
                }, false));
            if (result.settings().isEmpty()) rows.add(new Row("没有匹配的设置", null, null, false));
            header("文件");
            for (LauncherSearchIndex.FileResult file : result.files())
                rows.add(new Row(file.name(), null, () -> open(new Intent(Intent.ACTION_VIEW)
                        .setDataAndType(file.uri(), file.mime() == null ? "application/octet-stream" : file.mime())
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)), false));
            if (!result.fileNotice().isEmpty()) rows.add(new Row(result.fileNotice(), null, null, false));
            rows.add(new Row("授权文件夹", null, this::authorizeDirectory, false));
        }
        notifyRows();
    }

    private void notifyRows() {
        if (mode == Mode.GLOBAL_SEARCH) {
            String section = "";
            for (Row row : rows) { if (row.heading) section = row.title; row.section = section; }
        }
        adapter.notifyDataSetChanged();
    }

    private void buildAlphabet() {
        if (!input.getText().toString().trim().isEmpty() || sectionPositions.isEmpty()) {
            alphabet.setVisibility(GONE);
            return;
        }
        alphabet.setVisibility(VISIBLE);
        for (String section : sectionPositions.keySet()) {
            TextView letter = text(section, 11, colors.accent);
            letter.setGravity(Gravity.CENTER);
            letter.setContentDescription("跳转到 " + section);
            letter.setFocusable(true);
            letter.setOnClickListener(v -> list.setSelection(sectionPositions.get(section)));
            letter.setOnTouchListener((v, event) -> {
                android.view.accessibility.AccessibilityManager accessibility = activity.getSystemService(
                        android.view.accessibility.AccessibilityManager.class);
                if (accessibility.isTouchExplorationEnabled()) return false;
                if (event.getActionMasked() == MotionEvent.ACTION_DOWN || event.getActionMasked() == MotionEvent.ACTION_MOVE)
                    scrollAlphabet(v.getTop() + event.getY());
                if (event.getActionMasked() == MotionEvent.ACTION_UP) {
                    if (event.getY() >= 0 && event.getY() < v.getHeight()) v.performClick();
                    else scrollAlphabet(v.getTop() + event.getY());
                }
                return true;
            });
            alphabet.addView(letter, new LinearLayout.LayoutParams(-1, 0, 1));
        }
        alphabet.setOnTouchListener((v, event) -> {
            if (sectionPositions.isEmpty()) return false;
            if (event.getActionMasked() == MotionEvent.ACTION_DOWN || event.getActionMasked() == MotionEvent.ACTION_MOVE) {
                scrollAlphabet(event.getY());
                return true;
            }
            return event.getActionMasked() == MotionEvent.ACTION_UP;
        });
    }

    private void scrollAlphabet(float y) {
        int position = Math.min(sectionPositions.size() - 1, Math.max(0,
                (int) (y / Math.max(1, alphabet.getHeight()) * sectionPositions.size())));
        if (position >= 0) list.setSelection(new ArrayList<>(sectionPositions.values()).get(position));
    }

    private void header(String title) {
        Row row = new Row(title, null, null, false);
        row.heading = true;
        rows.add(row);
    }

    private void appGrid(List<LauncherSearchIndex.App> apps) {
        for (int i = 0; i < apps.size(); i += 4)
            rows.add(new Row(null, apps.subList(i, Math.min(i + 4, apps.size())), null, false));
    }

    private void launch(LauncherSearchIndex.App app) {
        try {
            activity.startActivity(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
                    .setComponent(app.component()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED));
            AppLaunchHistory.record(activity, app.component());
        } catch (RuntimeException failure) { message("无法打开应用，可能已停用或卸载"); }
    }

    private void launch(LauncherSearchIndex.Shortcut shortcut) {
        try {
            new LauncherShortcuts(activity).start(shortcut.info(), null);

        } catch (RuntimeException failure) { message("无法打开快捷方式，请检查默认桌面授权"); }
    }

    private void open(Intent intent) {
        try { activity.startActivity(intent); }
        catch (RuntimeException failure) { message("系统未提供此入口，或授权已失效"); }
    }

    private void startDrag(View source, DragItem item) {
        ClipData data = new ClipData(new ClipDescription(item.label(), new String[]{DRAG_MIME}),
                new ClipData.Item(item.component().flattenToString()));
        if (source.startDragAndDrop(data, new View.DragShadowBuilder(source), item, 0)) {
            keyboard().hideSoftInputFromWindow(input.getWindowToken(), 0);
            host.onDragStarted(item);
        }
    }

    /** Native SAF tree picker. Forward the host Activity's result to onActivityResult. */
    public void authorizeDirectory() {
        try {
            activity.startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION), DIRECTORY_REQUEST);
        } catch (RuntimeException failure) { message("系统没有可用的文件夹授权选择器"); }
    }

    public boolean onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != DIRECTORY_REQUEST) return false;
        if (resultCode == Activity.RESULT_OK && data != null && data.getData() != null) {
            try {
                if ((data.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) == 0)
                    throw new SecurityException("Missing read grant");
                activity.getContentResolver().takePersistableUriPermission(data.getData(), Intent.FLAG_GRANT_READ_URI_PERMISSION);
                search();
            } catch (SecurityException failure) { message("无法保留该目录的读取授权，请重新选择"); }
        }
        return true;
    }

    private void libraryOptions() {
        new AlertDialog.Builder(activity).setTitle("应用库")
                .setItems(new String[]{"全部应用", "最近使用", "最近安装", "编辑应用搜索别名", "刷新应用", "桌面搜索设置"}, (dialog, which) -> {
                    if (which < 3) { filter = which; search(); return; }
                    if (which == 4) { refresh(); return; }
                    if (which == 5) { host.openSettings("search"); return; }
                    if (index == null) { message("正在读取应用，请稍候"); return; }
                    List<LauncherSearchIndex.App> apps = index.apps;
                    new AlertDialog.Builder(activity).setTitle("选择应用")
                            .setItems(apps.stream().map(LauncherSearchIndex.App::label).toArray(String[]::new),
                                    (picker, selected) -> editAlias(apps.get(selected)))
                            .setNegativeButton("取消", null).show();
                }).show();
    }

    private void editAlias(LauncherSearchIndex.App app) {
        EditText alias = new EditText(activity);
        alias.setHint("别名，以空格分隔");
        android.content.SharedPreferences preferences = activity.getSharedPreferences("launcher_search", Context.MODE_PRIVATE);
        String key = "alias:" + app.component().flattenToString();
        alias.setText(preferences.getString(key, ""));
        new AlertDialog.Builder(activity).setTitle(app.label() + " · 搜索别名").setView(alias)
                .setNegativeButton("取消", null).setPositiveButton("保存", (dialog, which) -> {
                    preferences.edit().putString(key, alias.getText().toString().trim()).apply();
                    refresh();
                }).show();
    }

    private final class RowAdapter extends BaseAdapter {
        @Override public int getCount() { return rows.size(); }
        @Override public Object getItem(int position) { return rows.get(position); }
        @Override public long getItemId(int position) { return position; }
        @Override public boolean areAllItemsEnabled() { return false; }
        @Override public boolean isEnabled(int position) { return false; }
        @Override public View getView(int position, View recycled, ViewGroup parent) {
            Row row = rows.get(position);
            if (row.title == null) {
                LinearLayout grid = line();
                grid.setGravity(Gravity.TOP);
                if (row.grouped) {
                    TextView section = text(row.section, 16, colors.ink);
                    section.setPadding(0, dp(12), 0, 0); section.setAccessibilityHeading(true);
                    grid.addView(section, new LinearLayout.LayoutParams(dp(24), -2));
                }
                for (LauncherSearchIndex.App app : row.apps) {
                    LinearLayout cell = column();
                    cell.setGravity(Gravity.CENTER);
                    cell.setPadding(dp(2), dp(8), dp(2), dp(10));
                    ImageView icon = icon(app);
                    cell.addView(icon, new LinearLayout.LayoutParams(dp(52), dp(52)));
                    TextView label = text(app.label(), 13, colors.ink);
                    label.setGravity(Gravity.CENTER);
                    label.setMaxLines(1);
                    label.setEllipsize(android.text.TextUtils.TruncateAt.END);
                    label.setPadding(0, dp(7), 0, 0);
                    cell.addView(label, new LinearLayout.LayoutParams(-1, -2));
                    cell.setContentDescription(app.label() + "，长按拖到桌面");
                    cell.setFocusable(true);
                    cell.setOnClickListener(v -> launch(app));
                    cell.setOnLongClickListener(v -> { startDrag(v, new DragItem(app.component(), null, app.userSerial(), app.label())); return true; });
                    cell.setAccessibilityDelegate(new View.AccessibilityDelegate() {
                        @Override public void onInitializeAccessibilityNodeInfo(View host, android.view.accessibility.AccessibilityNodeInfo info) {
                            super.onInitializeAccessibilityNodeInfo(host, info);
                            info.addAction(new android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction(android.R.id.edit, "编辑搜索别名"));
                        }
                        @Override public boolean performAccessibilityAction(View host, int action, android.os.Bundle args) {
                            if (action == android.R.id.edit) { editAlias(app); return true; }
                            return super.performAccessibilityAction(host, action, args);
                        }
                    });
                    grid.addView(cell, new LinearLayout.LayoutParams(0, -2, 1));
                }
                for (int i = row.apps.size(); i < (row.grouped ? 3 : 4); i++) grid.addView(new View(activity), new LinearLayout.LayoutParams(0, 1, 1));
                return grid;
            }
            LinearLayout outer = column();
            boolean group = mode == Mode.GLOBAL_SEARCH && !row.section.isEmpty();
            boolean last = position + 1 == rows.size() || rows.get(position + 1).heading;
            outer.setPadding(0, dp(row.heading ? 8 : group ? 0 : 3), 0, dp(group ? (last ? 4 : 0) : 3));
            LinearLayout content = line();
            content.setPadding(dp(group ? 10 : 0), dp(row.heading ? 8 : 6), dp(8), dp(6));
            if (!row.heading) content.setBackground(panel(row.accent));
            if (row.heading && group) {
                content.addView(symbol(sectionIcon(row.section), colors.accent), new LinearLayout.LayoutParams(dp(20), dp(20)));
            }
            if (row.apps != null) {
                LauncherSearchIndex.App app = row.apps.get(0);
                content.addView(icon(app), new LinearLayout.LayoutParams(dp(42), dp(42)));
                content.setOnLongClickListener(v -> { startDrag(v, new DragItem(app.component(), null, app.userSerial(), app.label())); return true; });
            } else if (row.shortcut != null) {
                ImageView image = new ImageView(activity);
                try { image.setImageDrawable(new LauncherShortcuts(activity).icon(row.shortcut.info(), getResources().getDisplayMetrics().densityDpi)); }
                catch (RuntimeException ignored) { image.setImageDrawable(activity.getPackageManager().getDefaultActivityIcon()); }
                content.addView(image, new LinearLayout.LayoutParams(dp(42), dp(42)));
                content.setOnLongClickListener(v -> {
                    android.content.pm.ShortcutInfo shortcut = row.shortcut.info();
                    ComponentName component = shortcut.getActivity();
                    if (component == null) { message("此快捷方式没有可固定的应用入口"); return true; }
                    startDrag(v, new DragItem(component, shortcut.getId(), new LauncherShortcuts(activity).userSerial(shortcut), row.title));
                    return true;
                });
            }
            if (!row.heading && row.apps == null && row.shortcut == null && row.click != null) {
                ImageView icon = symbol(row.accent ? "paper-plane" : sectionIcon(row.section), colors.accent);
                GradientDrawable tile = panel(true); tile.setCornerRadius(dp(10));
                icon.setBackground(tile); icon.setPadding(dp(9), dp(9), dp(9), dp(9));
                content.addView(icon, new LinearLayout.LayoutParams(dp(38), dp(38)));
            }
            LinearLayout words = column();
            words.setPadding(row.heading && group || row.apps != null || row.shortcut != null || row.click != null ? dp(10) : 0, 0, dp(6), 0);
            TextView label = text(row.title, row.heading ? 15 : row.click == null ? 12 : 14,
                    row.click == null && !row.heading ? colors.muted : colors.ink);
            if (row.heading) { label.setTypeface(null, android.graphics.Typeface.BOLD); label.setAccessibilityHeading(true); }
            else { label.setMaxLines(2); label.setEllipsize(android.text.TextUtils.TruncateAt.END); }
            words.addView(label);
            if (row.accent) {
                label.setTypeface(null, android.graphics.Typeface.BOLD);
                TextView subtitle = text("新建对话并发送", 11, colors.muted); subtitle.setPadding(0, dp(3), 0, 0); words.addView(subtitle);
            }
            content.addView(words, new LinearLayout.LayoutParams(0, -2, 1));
            if (row.click != null) {
                content.setMinimumHeight(dp(52)); content.setFocusable(true); content.setOnClickListener(v -> row.click.run());
                if (row.accent) {
                    ImageView next = symbol("next", colors.accent);
                    content.addView(next, new LinearLayout.LayoutParams(dp(18), dp(18)));
                } else {
                    TextView open = action("打开", v -> row.click.run());
                    open.setTextSize(13);
                    open.setBackground(new android.graphics.drawable.InsetDrawable(panel(true), 0, dp(7), 0, dp(7)));
                    open.setPadding(dp(10), 0, dp(10), 0);
                    content.addView(open, new LinearLayout.LayoutParams(dp(62), dp(48)));
                }
            }
            if (row.apps != null) {
                LauncherSearchIndex.App app = row.apps.get(0);
                content.setAccessibilityDelegate(new View.AccessibilityDelegate() {
                    @Override public void onInitializeAccessibilityNodeInfo(View host, android.view.accessibility.AccessibilityNodeInfo info) {
                        super.onInitializeAccessibilityNodeInfo(host, info);
                        info.addAction(new android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction(android.R.id.edit, "编辑搜索别名"));
                    }
                    @Override public boolean performAccessibilityAction(View host, int action, android.os.Bundle args) {
                        if (action == android.R.id.edit) { editAlias(app); return true; }
                        return super.performAccessibilityAction(host, action, args);
                    }
                });
            }
            if (group) {
                FrameLayout groupSurface = new FrameLayout(activity);
                GradientDrawable background = new GradientDrawable();
                background.setColor(colors.dark ? 0xef193640 : 0xeff8fdff);
                float top = row.heading ? dp(20) : 0, bottom = last ? dp(20) : 0;
                background.setCornerRadii(new float[]{top, top, top, top, bottom, bottom, bottom, bottom});
                groupSurface.setBackground(background);
                FrameLayout.LayoutParams p = new FrameLayout.LayoutParams(-1, -2);
                p.setMargins(dp(8), 0, dp(8), row.heading ? 0 : dp(8));
                groupSurface.addView(content, p); outer.addView(groupSurface);
            } else outer.addView(content, new LinearLayout.LayoutParams(-1, -2));
            return outer;
        }
    }

    private ImageView icon(LauncherSearchIndex.App app) {
        ImageView icon = new ImageView(activity);
        try { icon.setImageDrawable(app.info().loadIcon(activity.getPackageManager())); }
        catch (RuntimeException ignored) { icon.setImageDrawable(activity.getPackageManager().getDefaultActivityIcon()); }
        icon.setScaleType(ImageView.ScaleType.FIT_CENTER);
        icon.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        return icon;
    }

    private static final class Row {
        final String title;
        final List<LauncherSearchIndex.App> apps;
        final Runnable click;
        final boolean accent;
        boolean heading, grouped;
        String section = "";
        LauncherSearchIndex.Shortcut shortcut;
        Row(String title, List<LauncherSearchIndex.App> apps, Runnable click, boolean accent) {
            this.title = title; this.apps = apps; this.click = click; this.accent = accent;
        }
    }

    private String sectionIcon(String section) {
        return switch (section) {
            case "AI 助手" -> "sparkles";
            case "应用" -> "grid";
            case "快捷方式" -> "link";
            case "设置" -> "settings";
            default -> "file";
        };
    }
    private ImageView symbol(String name, int color) {
        ImageView image = new ImageView(activity); image.setImageDrawable(new ChatIcon(name, color)); return image;
    }

    private GradientDrawable panel(boolean accent) {
        GradientDrawable background = new GradientDrawable();
        background.setColor((colors.dark ? 0xdf000000 : 0xc9000000) | ((accent ? colors.accent : colors.surface) & 0xffffff));
        if (accent) background.setColor((colors.dark ? 0x44000000 : 0x22000000) | (colors.accent & 0xffffff));
        background.setCornerRadius(dp(20));
        background.setStroke(Math.max(1, dp(1) / 2), colors.dark ? colors.border : 0x80ffffff);
        return background;
    }
    private LinearLayout column() { LinearLayout view = new LinearLayout(activity); view.setOrientation(LinearLayout.VERTICAL); return view; }
    private LinearLayout line() { LinearLayout view = new LinearLayout(activity); view.setGravity(Gravity.CENTER_VERTICAL); return view; }
    private TextView text(String value, int size, int color) {
        TextView text = new TextView(activity); text.setText(value); text.setTextSize(size); text.setTextColor(color); return text;
    }
    private TextView action(String value, View.OnClickListener click) {
        TextView view = text(value, 14, colors.accent); view.setGravity(Gravity.CENTER);
        view.setMinWidth(dp(48)); view.setMinHeight(dp(48)); view.setPadding(dp(8), 0, dp(8), 0);
        view.setFocusable(true); view.setOnClickListener(click); Motion.press(view); return view;
    }
    private InputMethodManager keyboard() { return activity.getSystemService(InputMethodManager.class); }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private void message(String text) { Toast.makeText(activity, text, Toast.LENGTH_SHORT).show(); }
}
