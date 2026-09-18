package com.example.launcherprobe;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Dialog;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.LauncherApps;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.pm.ShortcutInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.RenderEffect;
import android.graphics.Shader;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.VelocityTracker;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;

import androidx.dynamicanimation.animation.FloatValueHolder;
import androidx.dynamicanimation.animation.SpringAnimation;
import android.view.Window;
import android.view.WindowManager;
import android.widget.AbsListView;
import android.widget.BaseAdapter;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.GridLayout;
import android.widget.GridView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Native desktop grid, folder surface, app picker, shortcut menu, and drag interactions. */
final class HomeDesktop extends FrameLayout {
    private static final int HOME = 0;
    private static final int ALL_APPS = 1;
    private static final int FOLDER = 2;
    private static final long LONG_PRESS_MS = 450;
    private static final long MERGE_HOVER_MS = 450;

    private final Activity activity;
    private final PagerRoot pager;
    private final HomeLayout layout;
    private final LauncherShortcuts shortcuts;
    private final FrameLayout homeOverlay;
    private final PackageManager packages;
    private final AppAppearance colors;
    private final DesktopPreferences preferences;
    private final DesktopIconPack iconPack;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final int touchSlop;
    private final float minimumFlingVelocity;
    private final FrameLayout pageTrack;
    private GridLayout grid;
    private GridLayout adjacentGrid;
    private final LinearLayout dock;
    private final LinearLayout tools;
    private final TextView pages;
    private final DesktopWidgets widgets;
    private final HashMap<Integer, View> homeCells = new HashMap<>();
    private View aiWidget;
    private int currentPage;
    private boolean editing;
    private long ignoreEditUntil;
    private Runnable libraryAction = this::showAllApps, searchAction = this::showAllApps;
    private Runnable assistantAction = () -> {}, settingsAction = () -> {};
    private Overlay overlay;
    private int dragHover = -1, edgeDirection;
    private long dragHoverSince;
    private Object externalDragToken;
    private HomeLayout.Item externalDragItem;
    private final Runnable edgeTurn = new Runnable() {
        @Override public void run() {
            if (edgeDirection == 0) return;
            int next = currentPage + edgeDirection;
            if (next < 0) return;
            if (next >= layout.pageCount()) layout.addPage();
            currentPage = next; render();
            handler.postDelayed(this, 900);
        }
    };
    private List<ResolveInfo> apps;

    private DesktopMenu menu;
    private View dropTarget;
    private Dialog appDialog;
    private FrameLayout folderRoot;
    private FrameLayout folderPanel;
    private View folderBackground;
    private LinearLayout folderSurface;
    private GridLayout folderGrid;
    private Bitmap folderBackdrop;
    private androidx.activity.OnBackPressedCallback folderBack;
    private View dragPreview;
    private int activeFolderSlot = -1;
    private boolean disposed;
    private float swipeX, swipeY, swipeStartOffset, pageOffset, folderFromX, folderFromY, folderFromScale = .92f;
    private int swipeAxis, pageShift;
    private boolean paging, pulling, folderClosing;
    private boolean pullSearch;
    private float pullProgress;
    private VelocityTracker swipeVelocity;
    private SpringAnimation pageSpring;
    private int folderOriginSlot = -1;

    interface Overlay {
        void pull(boolean search, float progress);
        void settle(boolean search, boolean open, float velocity);
    }

    HomeDesktop(Activity activity, PagerRoot pager, HomeLayout layout,
            List<ResolveInfo> apps, LauncherShortcuts shortcuts, FrameLayout homeOverlay) {
        super(activity);
        this.activity = activity;
        this.pager = pager;
        this.layout = layout;
        this.apps = apps;
        this.shortcuts = shortcuts;
        this.homeOverlay = homeOverlay;
        packages = activity.getPackageManager();
        preferences = new DesktopPreferences(activity);
        iconPack = new DesktopIconPack(activity);
        layout.configureGrid(preferences.columns(), preferences.rows());
        colors = AppAppearance.readDesktop(activity);
        ViewConfiguration configuration = ViewConfiguration.get(activity);
        touchSlop = configuration.getScaledTouchSlop();
        minimumFlingVelocity = Math.max(configuration.getScaledMinimumFlingVelocity(),
                600 * getResources().getDisplayMetrics().density);
        setClipChildren(false);
        setClipToPadding(false);
        pageTrack = new FrameLayout(activity);
        pageTrack.setClipChildren(true);
        grid = pageGrid();
        widgets = new DesktopWidgets(activity, layout, this::persist);
        LinearLayout surface = column();
        tools = row();
        TextView add = compact("添加", this::showAddMenu);
        toolbarIcon(add, "plus"); tools.addView(add);
        tools.addView(new View(activity), new LinearLayout.LayoutParams(0, 1, 1));
        ImageView more = new ImageView(activity);
        more.setImageDrawable(new ChatIcon("more", colors.muted)); more.setPadding(dp(13), dp(13), dp(13), dp(13));
        more.setContentDescription("更多整理操作"); more.setFocusable(true);
        more.setOnClickListener(v -> new AlertDialog.Builder(activity).setItems(new String[]{"撤销上次修改", "桌面设置"},
                (dialog, which) -> { if (which == 0) undo(); else settingsAction.run(); }).show());
        tools.addView(more, new LinearLayout.LayoutParams(dp(48), dp(48)));
        TextView done = compact("完成", () -> {
            exitEdit();
            new Thread(() -> {
                try { new DesktopBackup(activity).snapshot(); }
                catch (Exception e) { activity.runOnUiThread(() -> message("桌面已保存，但历史快照失败：" + e.getMessage())); }
            }, "desktop-snapshot").start();
        });
        toolbarIcon(done, "check"); tools.addView(done);
        surface.addView(tools, new LinearLayout.LayoutParams(-1, dp(48)));
        grid.setColumnCount(layout.columns);
        grid.setRowCount(layout.rows);
        pageTrack.addView(grid, new FrameLayout.LayoutParams(-1, -1));
        surface.addView(pageTrack, new LinearLayout.LayoutParams(-1, 0, 1));
        pages = text("", 16, colors.accent);
        pages.setGravity(Gravity.CENTER);
        pages.setOnClickListener(v -> setCurrentPage((currentPage + 1) % layout.pageCount()));
        surface.addView(pages, new LinearLayout.LayoutParams(-1, dp(24)));
        dock = row();
        dock.setBackground(shape(colors.dark ? 0xc0274855 : 0xbbebfaff, 24, 0, 0));
        surface.addView(dock, new LinearLayout.LayoutParams(-1, dp(88)));
        addView(surface, new FrameLayout.LayoutParams(-1, -1));
        setOnDragListener(this::desktopDrag);
        setLongClickable(true);
        setOnLongClickListener(v -> { enterEdit(); return true; });
        render();
    }

    void setNavigation(Runnable library, Runnable search, Runnable assistant, Runnable settings, Overlay overlay) {
        libraryAction = exitEditThen(library);
        searchAction = exitEditThen(search);
        assistantAction = exitEditThen(assistant);
        settingsAction = exitEditThen(settings);
        this.overlay = overlay == null ? null : new Overlay() {
            @Override public void pull(boolean search, float progress) {
                overlay.pull(search, progress);
            }
            @Override public void settle(boolean search, boolean open, float velocity) {
                if (open) exitEdit();
                overlay.settle(search, open, velocity);
            }
        };
    }
    void setAiWidget(View view) { aiWidget = view; render(); }
    void startListening() { widgets.start(); }
    void stopListening() { widgets.stop(); }
    boolean onActivityResult(int request, int result, Intent data) { return widgets.result(request, result); }
    void notifyLayoutChanged() { persist(); }
    void setCurrentPage(int page) {
        abortPageDrag();
        currentPage = Math.max(0, Math.min(layout.pageCount() - 1, page)); render();
    }
    private boolean locked() {
        return preferences.layoutLocked();
    }
    void ignoreEdit(int ms) {
        ignoreEditUntil = android.os.SystemClock.uptimeMillis() + ms;
        cancelLongPress();
    }
    void enterEdit() {
        if (android.os.SystemClock.uptimeMillis() < ignoreEditUntil) return;
        if (locked()) { message("桌面布局已锁定"); return; }
        editing = true; render();
    }
    void exitEdit() {
        if (!editing) return;
        editing = false;
        render();
    }
    boolean editing() { return editing; }
    private Runnable exitEditThen(Runnable action) {
        return () -> { exitEdit(); action.run(); };
    }
    void undo() {
        if (locked()) return;
        List<HomeLayout.Item> before = new ArrayList<>(layout.slots());
        if (!layout.undo()) { message("没有可撤销的整理操作"); return; }
        for (HomeLayout.Item item : before) if (item != null && HomeLayout.Item.APPWIDGET.equals(item.type)) {
            boolean retained = false;
            for (HomeLayout.Item next : layout.slots()) if (next != null && next.appWidgetId == item.appWidgetId) retained = true;
            if (!retained) widgets.remove(item);
        }
        syncPins(); render();
    }
    void showAddMenu() {
        if (locked()) { message("桌面布局已锁定"); return; }
        new AlertDialog.Builder(activity).setTitle("添加到桌面")
                .setItems(new String[]{"应用", "系统小组件", "AI 助手小组件", "时钟与日期", "新桌面页"}, (d, choice) -> {
                    if (choice == 0) showAppPicker(layout.vacancy(1, 1), -1);
                    if (choice == 1) widgets.choose();
                    if (choice == 2) {
                        for (HomeLayout.Item item : layout.slots()) if (item != null && HomeLayout.Item.AI_WIDGET.equals(item.type)) {
                            message("AI 小组件已在桌面上"); return;
                        }
                        int x = Math.min(4, layout.columns), y = Math.min(3, layout.rows);
                        layout.set(layout.vacancy(x, y), HomeLayout.Item.widget(HomeLayout.Item.AI_WIDGET, x, y, -1, null)); persist();
                    }
                    if (choice == 3) {
                        int x = Math.min(4, layout.columns);
                        layout.set(layout.vacancy(x, 1), HomeLayout.Item.widget(HomeLayout.Item.CLOCK, x, 1, -1, null)); persist();
                    }
                    if (choice == 4) { layout.addPage(); currentPage = layout.pageCount() - 1; persist(); }
                }).setNegativeButton("取消", null).show();
    }
    private void renderDock() {
        dock.setVisibility(preferences.dockVisible() ? VISIBLE : GONE);
        dock.removeAllViews();
        for (int i = 0; i < layout.dock().size(); i++) {
            int index = i;
            HomeLayout.Item item = layout.dock().get(i);
            Cell cell = cell(item);
            cell.setPadding(dp(2), dp(5), dp(2), 0);
            if (item == null) {
                TextView add = text("＋", 26, colors.accent); add.setGravity(Gravity.CENTER);
                cell.addView(add, new LinearLayout.LayoutParams(-1, dp(52)));
            }
            cell.setOnClickListener(v -> {
                if (item == null || editing) configureDock(index); else activate(item, v, -1);
            });
            cell.setOnLongClickListener(v -> {
                if (locked()) return true;
                if (item == null) configureDock(index);
                else { editing = true; tools.setVisibility(VISIBLE); startItemDrag(v, item, -1, index); }
                return true;
            });
            dock.addView(cell, new LinearLayout.LayoutParams(0, -1, 1));
        }
    }
    void editDock() {
        if (locked()) { message("桌面布局已锁定"); return; }
        new AlertDialog.Builder(activity).setTitle("配置 Dock")
                .setItems(new String[]{"第 1 项", "第 2 项", "第 3 项", "第 4 项", "第 5 项"}, (d, which) -> configureDock(which)).show();
    }
    void manageFolders() {
        if (locked()) { message("桌面布局已锁定"); return; }
        ArrayList<Integer> slots = new ArrayList<>(); ArrayList<String> names = new ArrayList<>();
        for (int i = 0; i < layout.size(); i++) {
            HomeLayout.Item item = layout.get(i);
            if (item != null && item.isFolder()) { slots.add(i); names.add(item.name); }
        }
        if (slots.isEmpty()) { enterEdit(); message("长按应用拖到另一图标中心停留，即可创建文件夹"); return; }
        new AlertDialog.Builder(activity).setTitle("桌面文件夹")
                .setItems(names.toArray(new String[0]), (d, which) -> {
                    int slot = slots.get(which); setCurrentPage(slot / layout.pageSize()); openFolder(slot);
                }).show();
    }
    void configureDock(int index) {
        if (locked()) return;
        String[] labels = new String[apps.size() + 2];
        labels[0] = "移除此位置"; labels[1] = "e助手";
        for (int i = 0; i < apps.size(); i++) labels[i + 2] = apps.get(i).loadLabel(packages).toString();
        new AlertDialog.Builder(activity).setTitle("Dock 第 " + (index + 1) + " 项")
                .setItems(labels, (d, which) -> {
                    HomeLayout.Item item = null;
                    if (which == 1) item = HomeLayout.Item.assistant();
                    if (which >= 2) {
                        ResolveInfo app = apps.get(which - 2);
                        item = HomeLayout.Item.app(app.activityInfo.packageName, app.activityInfo.name);
                    }
                    layout.setDock(index, item); persist();
                }).show();
    }
    private View widgetCell(HomeLayout.Item item, int slot) { return widgetCell(item, slot, true); }
    private View widgetCell(HomeLayout.Item item, int slot, boolean live) {
        FrameLayout frame = new FrameLayout(activity) {
            float downX, downY;
            final Runnable hold = () -> {
                if (!locked()) { editing = true; tools.setVisibility(VISIBLE); startItemDrag(this, item, slot, -1); }
            };
            @Override protected void onMeasure(int widthSpec, int heightSpec) {
                if (HomeLayout.Item.AI_WIDGET.equals(item.type) && aiWidget instanceof HomeTaskCards cards)
                    cards.setAvailableHeight(MeasureSpec.getSize(heightSpec));
                super.onMeasure(widthSpec, heightSpec);
            }
            @Override public boolean dispatchTouchEvent(MotionEvent event) {
                if (event.getActionMasked() == MotionEvent.ACTION_DOWN) {
                    downX = event.getX(); downY = event.getY(); handler.postDelayed(hold, LONG_PRESS_MS);
                } else if (event.getActionMasked() == MotionEvent.ACTION_UP || event.getActionMasked() == MotionEvent.ACTION_CANCEL
                        || Math.hypot(event.getX() - downX, event.getY() - downY) > touchSlop) handler.removeCallbacks(hold);
                return super.dispatchTouchEvent(event);
            }
            @Override protected void onDetachedFromWindow() { handler.removeCallbacks(hold); super.onDetachedFromWindow(); }
        };
        if (!HomeLayout.Item.AI_WIDGET.equals(item.type)) {
            frame.setBackground(shape(colors.dark ? 0xc0254552 : 0xcceffbff, 22, 0, 0));
            frame.setClipToOutline(true);
        }
        View content = null;
        if (HomeLayout.Item.AI_WIDGET.equals(item.type)) {
            if (!live) content = snapshot(aiWidget);
            else {
                if (aiWidget instanceof HomeTaskCards cards) cards.setEditing(editing);
                content = aiWidget;
            }
        }
        else if (HomeLayout.Item.CLOCK.equals(item.type)) {
            LinearLayout time = row(); time.setPadding(dp(16), dp(4), dp(16), dp(4));
            android.widget.TextClock clock = new android.widget.TextClock(activity);
            clock.setFormat12Hour("h:mm"); clock.setFormat24Hour("HH:mm");
            clock.setTextColor(colors.ink); clock.setTextSize(38); clock.setTypeface(null, android.graphics.Typeface.BOLD);
            clock.setAutoSizeTextTypeUniformWithConfiguration(20, 42, 1, android.util.TypedValue.COMPLEX_UNIT_SP);
            time.addView(clock, new LinearLayout.LayoutParams(0, -2, 1));
            android.widget.TextClock date = new android.widget.TextClock(activity);
            date.setFormat12Hour("M月d日 EEEE"); date.setFormat24Hour("M月d日 EEEE");
            date.setTextColor(colors.ink); date.setTextSize(14);
            time.addView(date, new LinearLayout.LayoutParams(0, -2, 1)); content = time;
        } else if (HomeLayout.Item.WIDGET_PICKER.equals(item.type)) {
            TextView add = text("＋ 添加小组件\n照片、待办等内容由已安装应用提供", 16, colors.accent);
            add.setGravity(Gravity.CENTER); add.setPadding(dp(12), dp(8), dp(12), dp(8));
            add.setOnClickListener(v -> { if (!locked()) widgets.choose(); }); content = add;
        } else content = widgets.view(item);
        if (content == null) {
            TextView add = text(HomeLayout.Item.APPWIDGET.equals(item.type) ? "点击重新绑定小组件" : "✦ 开始对话", 18, colors.accent);
            add.setGravity(Gravity.CENTER);
            add.setOnClickListener(v -> { if (HomeLayout.Item.APPWIDGET.equals(item.type)) widgets.rebind(slot); else assistantAction.run(); });
            content = add;
        }
        if (content.getParent() instanceof ViewGroup parent) parent.removeView(content);
        frame.addView(content, new FrameLayout.LayoutParams(-1, -1));
        if (editing) {
            View edit = new View(activity);
            edit.setBackground(shape(0x08ffffff, 22, 1, colors.dark ? 0x99a9d6e0 : 0xddffffff));
            edit.setContentDescription("小组件：点击调整尺寸或移除，长按拖动");
            edit.setOnClickListener(v -> widgetMenu(item, slot));
            frame.addView(edit, new FrameLayout.LayoutParams(-1, -1));
        }
        return frame;
    }
    private void widgetMenu(HomeLayout.Item item, int slot) {
        new AlertDialog.Builder(activity).setTitle("桌面小组件")
                .setItems(new String[]{"调整尺寸", "从桌面移除"}, (d, choice) -> {
                    if (choice == 1) { if (widgets.remove(item)) { layout.remove(slot); persist(); } }
                    else {
                        ArrayList<String> labels = new ArrayList<>(); ArrayList<int[]> sizes = new ArrayList<>();
                        for (int y = 1; y <= layout.rows; y++) for (int x = 1; x <= layout.columns; x++) {
                            if (!layout.fits(slot, x, y, slot) || !widgets.canResize(item, x, y,
                                    grid.getWidth() / layout.columns, grid.getHeight() / layout.rows)) continue;
                            if (HomeLayout.Item.AI_WIDGET.equals(item.type) && (x < Math.min(3, layout.columns) || y < 2)) continue;
                            labels.add(x + " × " + y); sizes.add(new int[]{x, y});
                        }
                        new AlertDialog.Builder(activity).setTitle("选择可用网格尺寸")
                                .setItems(labels.toArray(new String[0]), (dialog, which) -> {
                                    int[] size = sizes.get(which); if (layout.resize(slot, size[0], size[1])) persist();
                                }).show();
                    }
                }).show();
    }
    private record DragItem(HomeLayout.Item item, int slot, int dockIndex) { }
    /** Search Host.onDragStarted registers its local-state token before revealing this workspace. */
    void acceptExternalDrag(Object token, HomeLayout.Item item) {
        if (token == null || item == null || !(HomeLayout.Item.APP.equals(item.type) || item.isShortcut())) return;
        externalDragToken = token; externalDragItem = item;
    }
    void beginExternalDrag(View source, HomeLayout.Item item) {
        if (item == null || !(HomeLayout.Item.APP.equals(item.type) || item.isShortcut())) return;
        startItemDrag(source, item, -1, -1);
    }
    private void startItemDrag(View source, HomeLayout.Item item, int slot, int dockIndex) {
        if (locked()) return;
        pager.setGestureBlocked(pager.gestureId(), true);
        source.startDragAndDrop(android.content.ClipData.newPlainText("desktop-item", item.type),
                new View.DragShadowBuilder(source), new DragItem(item, slot, dockIndex), 0);
    }
    private boolean desktopDrag(View ignored, android.view.DragEvent event) {
        if (locked()) return false;
        DragItem drag;
        if (event.getLocalState() instanceof DragItem internal) drag = internal;
        else if (event.getLocalState() == externalDragToken && externalDragItem != null)
            drag = new DragItem(externalDragItem, -1, -1);
        else return false;
        int[] origin = new int[2]; getLocationOnScreen(origin);
        float x = origin[0] + event.getX(), y = origin[1] + event.getY();
        switch (event.getAction()) {
            case android.view.DragEvent.ACTION_DRAG_STARTED:
                editing = true; tools.setVisibility(VISIBLE); dragHover = -1; return true;
            case android.view.DragEvent.ACTION_DRAG_LOCATION:
                int direction = event.getX() < dp(28) ? -1 : event.getX() > getWidth() - dp(28) ? 1 : 0;
                if (direction != edgeDirection) {
                    handler.removeCallbacks(edgeTurn); edgeDirection = direction;
                    if (direction != 0) handler.postDelayed(edgeTurn, 650);
                }
                int target = homeTarget(x, y);
                int owner = target < 0 ? -1 : layout.ownerAt(target);
                boolean mergeable = owner >= 0 && owner != drag.slot && !drag.item.isWidget() && !drag.item.isFolder()
                        && !HomeLayout.Item.ASSISTANT.equals(drag.item.type) && !layout.get(owner).isWidget()
                        && !HomeLayout.Item.ASSISTANT.equals(layout.get(owner).type) && centerHit(homeCells.get(owner), x, y);
                int hover = mergeable ? owner : -1;
                if (hover != dragHover) { dragHover = hover; dragHoverSince = android.os.SystemClock.uptimeMillis(); }
                highlightDrop(owner >= 0 ? owner : target, hover >= 0 && android.os.SystemClock.uptimeMillis() - dragHoverSince >= MERGE_HOVER_MS);
                return true;
            case android.view.DragEvent.ACTION_DROP:
                if (drag.item.isShortcut() && !shortcuts.hasAccess()) { promptDefaultHome(); return false; }
                boolean changed = false;
                if (contains(dock, x, y) && !drag.item.isWidget() && !drag.item.isFolder()) {
                    int[] dockOrigin = new int[2]; dock.getLocationOnScreen(dockOrigin);
                    int index = Math.max(0, Math.min(4, (int) ((x - dockOrigin[0]) * 5 / Math.max(1, dock.getWidth()))));
                    HomeLayout.Item existing = layout.dock().get(index);
                    if (drag.dockIndex >= 0) { layout.setDock(drag.dockIndex, existing); layout.setDock(index, drag.item); changed = true; }
                    else if (existing == null) {
                        layout.setDock(index, drag.item); if (drag.slot >= 0) layout.remove(drag.slot); changed = true;
                    } else message("Dock 位置已占用；点击该位置可明确替换");
                } else {
                    int destination = homeTarget(x, y);
                    if (destination >= 0) {
                        int targetOwner = layout.ownerAt(destination);
                        boolean merge = targetOwner >= 0 && targetOwner == dragHover
                                && android.os.SystemClock.uptimeMillis() - dragHoverSince >= MERGE_HOVER_MS;
                        if (merge && drag.slot >= 0) changed = layout.merge(drag.slot, targetOwner, "文件夹");
                        else if (merge && !drag.item.isWidget() && !drag.item.isFolder()
                                && !HomeLayout.Item.ASSISTANT.equals(drag.item.type)) {
                            HomeLayout.Item targetItem = layout.get(targetOwner);
                            if (targetItem.isFolder()) changed = layout.addToFolder(targetOwner, drag.item);
                            else if (!targetItem.isWidget() && !HomeLayout.Item.ASSISTANT.equals(targetItem.type)) {
                                layout.set(targetOwner, HomeLayout.Item.folder("文件夹", List.of(targetItem, drag.item))); changed = true;
                            }
                        } else if (drag.slot >= 0) changed = layout.move(drag.slot, destination);
                        else if (layout.fits(destination, drag.item.spanX, drag.item.spanY, -1)) {
                            layout.set(destination, drag.item); changed = true;
                        }
                        if (changed && drag.dockIndex >= 0) layout.setDock(drag.dockIndex, null);
                    }
                }
                if (changed) persist(); else message("无法放在此处，请选择空位或在图标中心停留建立文件夹");
                return changed;
            case android.view.DragEvent.ACTION_DRAG_EXITED:
            case android.view.DragEvent.ACTION_DRAG_ENDED:
                edgeDirection = 0; handler.removeCallbacks(edgeTurn); clearDropTarget();
                if (event.getAction() == android.view.DragEvent.ACTION_DRAG_ENDED) {
                    externalDragToken = null; externalDragItem = null; layout.save(); render();
                }
                return true;
            default: return true;
        }
    }
    @Override public boolean onInterceptTouchEvent(MotionEvent event) {
        if (event.getActionMasked() == MotionEvent.ACTION_DOWN) {
            // Take over at the displayed position before a new gesture can replace the target page.
            cancelPageSpring();
            swipeStartOffset = pageOffset;
            swipeX = event.getX(); swipeY = event.getY();
            paging = adjacentGrid != null;
            pulling = false;
            swipeAxis = paging ? 1 : 0;
            pager.setGestureBlocked(pager.gestureId(), true);
            recycleSwipeVelocity();
            swipeVelocity = VelocityTracker.obtain();
            swipeVelocity.addMovement(event);
            if (paging) return true;
        } else if (swipeVelocity != null) swipeVelocity.addMovement(event);
        if (event.getActionMasked() == MotionEvent.ACTION_MOVE && !editing && folderRoot == null) {
            float dx = event.getX() - swipeX, dy = event.getY() - swipeY;
            if (Math.abs(dx) > touchSlop * 2 || Math.abs(dy) > touchSlop * 2) {
                int[] origin = new int[2]; getLocationOnScreen(origin);
                int slot = homeTarget(origin[0] + swipeX, origin[1] + swipeY);
                int owner = slot < 0 ? -1 : layout.ownerAt(slot);
                if (owner >= 0 && layout.get(owner).isWidget()) return false;
                return true;
            }
        }
        if ((event.getActionMasked() == MotionEvent.ACTION_UP || event.getActionMasked() == MotionEvent.ACTION_CANCEL)
                && !paging && !pulling) recycleSwipeVelocity();
        return super.onInterceptTouchEvent(event);
    }
    @Override public boolean onTouchEvent(MotionEvent event) {
        if (editing || folderRoot != null) return super.onTouchEvent(event);
        if (swipeVelocity != null) swipeVelocity.addMovement(event);
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN && paging) return true;
        if (action == MotionEvent.ACTION_MOVE) {
            trackSwipe(event.getX() - swipeX, event.getY() - swipeY);
            if (paging || pulling) return true;
        } else if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
            if (paging || pulling) {
                float velocityX = 0, velocityY = 0;
                if (swipeVelocity != null) {
                    swipeVelocity.computeCurrentVelocity(1000);
                    velocityX = swipeVelocity.getXVelocity();
                    velocityY = swipeVelocity.getYVelocity();
                }
                settleSwipe(velocityX, velocityY, action == MotionEvent.ACTION_CANCEL);
                recycleSwipeVelocity();
                pager.setGestureBlocked(pager.gestureId(), false);
                return true;
            }
            recycleSwipeVelocity();
            pager.setGestureBlocked(pager.gestureId(), false);
        }
        return super.onTouchEvent(event);
    }

    private void trackSwipe(float dx, float dy) {
        if (swipeAxis == 0) {
            if (Math.abs(dx) < touchSlop && Math.abs(dy) < touchSlop) return;
            swipeAxis = Math.abs(dx) > Math.abs(dy) * 1.1f ? 1 : 2;
        }
        if (swipeAxis == 1) {
            pulling = false;
            float offset = swipeStartOffset + dx;
            int shift = offset < 0 ? 1 : -1;
            if (offset == 0 || !prepareAdjacent(shift)) {
                applyPageOffset(0);
                return;
            }
            paging = true;
            applyPageOffset(offset);
            return;
        }
        String action = dy < 0 ? preferences.swipeUp() : preferences.swipeDown();
        boolean search = "search".equals(action);
        if (!"library".equals(action) && !search) return;
        paging = false;
        pulling = true;
        pullSearch = search;
        float range = Math.max(dp(160), getHeight() * .45f);
        pullProgress = Math.max(0, Math.min(1, Math.abs(dy) / range));
        if (overlay != null) overlay.pull(search, pullProgress);
    }

    private void settleSwipe(float velocityX, float velocityY, boolean cancel) {
        if (paging) {
            settlePage(velocityX, cancel);
            paging = false;
            return;
        }
        if (pulling) {
            float directed = pullSearch ? velocityY : -velocityY;
            boolean open = !cancel && Motion.crossed(pullProgress, directed, minimumFlingVelocity, false);
            if (overlay != null) overlay.settle(pullSearch, open, velocityY);
            else if (open) {
                if (pullSearch) searchAction.run(); else libraryAction.run();
            }
            pulling = false;
            pullProgress = 0;
            return;
        }
        abortPageDrag();
    }

    private boolean prepareAdjacent(int shift) {
        int next = currentPage + shift;
        if (next < 0 || next >= layout.pageCount()) {
            dropAdjacent();
            pageShift = 0;
            return false;
        }
        if (pageShift == shift && adjacentGrid != null) return true;
        dropAdjacent();
        pageShift = shift;
        adjacentGrid = pageGrid();
        fillPage(adjacentGrid, next, false);
        pageTrack.addView(adjacentGrid, 0, new FrameLayout.LayoutParams(-1, -1));
        return true;
    }

    private void applyPageOffset(float offset) {
        int width = Math.max(1, pageTrack.getWidth());
        pageOffset = Math.max(-width, Math.min(width, offset));
        if (pageShift > 0) pageOffset = Math.min(0, pageOffset);
        if (pageShift < 0) pageOffset = Math.max(0, pageOffset);
        grid.setTranslationX(pageOffset);
        if (adjacentGrid != null) adjacentGrid.setTranslationX(pageOffset + (pageShift > 0 ? width : -width));
    }

    private void settlePage(float velocityX, boolean cancel) {
        int width = Math.max(1, pageTrack.getWidth());
        boolean commit = !cancel && pageShift != 0 && adjacentGrid != null
                && Motion.crossed(Math.abs(pageOffset) / (float) width,
                pageShift > 0 ? -velocityX : velocityX, minimumFlingVelocity, false);
        float end = commit ? (pageShift > 0 ? -width : width) : 0;
        cancelPageSpring();
        int shift = pageShift;
        if (pageOffset == end || !Motion.enabled()) {
            if (commit) commitPage(shift);
            else abortPageDrag();
            return;
        }
        FloatValueHolder holder = new FloatValueHolder(pageOffset);
        pageSpring = Motion.spring(holder, pageOffset, end, velocityX,
                (a, value, velocity) -> applyPageOffset(value),
                (a, canceled, value, velocity) -> {
                    if (canceled || pageSpring != a) return;
                    pageSpring = null;
                    if (commit) commitPage(shift);
                    else abortPageDrag();
                });
    }

    private void commitPage(int shift) {
        currentPage = Math.max(0, Math.min(layout.pageCount() - 1, currentPage + shift));
        pageTrack.removeView(grid);
        grid = adjacentGrid;
        adjacentGrid = null;
        pageShift = 0;
        pageOffset = 0;
        if (grid != null) grid.setTranslationX(0);
        fillPage(grid, currentPage, true);
        updatePageDots();
    }

    private void dropAdjacent() {
        if (adjacentGrid == null) return;
        pageTrack.removeView(adjacentGrid);
        adjacentGrid = null;
    }

    private void cancelPageSpring() {
        if (pageSpring == null) return;
        SpringAnimation current = pageSpring;
        pageSpring = null;
        current.cancel();
    }

    private void abortPageDrag() {
        cancelPageSpring();
        dropAdjacent();
        pageShift = 0;
        pageOffset = 0;
        paging = false;
        if (grid != null) grid.setTranslationX(0);
    }

    private void recycleSwipeVelocity() {
        if (swipeVelocity != null) swipeVelocity.recycle();
        swipeVelocity = null;
    }

    void appsChanged(List<ResolveInfo> value) {
        apps = value;
        render();
        if (folderRoot != null) renderFolder();
    }

    void shortcutsChanged() {
        render();
        if (folderRoot != null) renderFolder();
    }

    void packageRemoved(String packageName) {
        layout.removePackage(packageName);
        persist();
    }

    void syncPins() {
        if (!shortcuts.hasAccess()) return;
        ArrayList<LauncherShortcuts.Pin> desired = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (HomeLayout.Item item : layout.shortcutItems()) {
            String key = item.packageName + "\n" + item.shortcutId + "\n" + item.userSerial;
            if (seen.add(key)) desired.add(new LauncherShortcuts.Pin(
                    item.packageName, item.shortcutId, item.userSerial));
        }
        try {
            shortcuts.syncPins(desired);
        } catch (RuntimeException failure) {
            message(tr("无法同步快捷功能固定状态：", "Could not sync shortcut pins: ")
                    + failure.getMessage());
        }
    }

    void dispose() {
        disposed = true;
        handler.removeCallbacksAndMessages(null);
        recycleSwipeVelocity();
        abortPageDrag();
        dismissMenu();
        if (appDialog != null) appDialog.dismiss();
        closeFolder(false);
        clearDragPreview();
        widgets.stop();
    }

    void showAllApps() {
        showAppPicker(-1, -1);
    }

    void confirmPin(LauncherApps.PinItemRequest request) {
        ShortcutInfo shortcut = request == null ? null : request.getShortcutInfo();
        if (shortcut == null || !request.isValid()) {
            message(tr("固定请求已失效。", "The pin request is no longer valid."));
            return;
        }
        if (!shortcuts.hasAccess()) {
            promptDefaultHome();
            return;
        }
        HomeLayout.Item item = HomeLayout.Item.shortcut(shortcut.getPackage(), shortcut.getId(),
                shortcuts.userSerial(shortcut));
        chooseDestination(item, () -> {
            if (!request.isValid() || !request.accept()) {
                throw new IllegalStateException(tr("系统未接受固定请求", "The system rejected the pin request"));
            }
        });
    }

    private void render() {
        if (disposed) return;
        abortPageDrag();
        dismissMenu();
        clearDropTarget();
        tools.setVisibility(editing ? VISIBLE : GONE);
        currentPage = Math.min(currentPage, layout.pageCount() - 1);
        fillPage(grid, currentPage, true);
        updatePageDots();
        renderDock();
    }

    private GridLayout pageGrid() {
        return new GridLayout(activity) {
            @Override protected void onMeasure(int widthSpec, int heightSpec) {
                int width = MeasureSpec.getSize(widthSpec), height = MeasureSpec.getSize(heightSpec);
                for (int i = 0; i < getChildCount(); i++) {
                    View child = getChildAt(i);
                    HomeLayout.Item item = layout.get((Integer) child.getTag());
                    GridLayout.LayoutParams p = (GridLayout.LayoutParams) child.getLayoutParams();
                    p.width = Math.max(0, width * (item == null ? 1 : item.spanX) / layout.columns - p.leftMargin - p.rightMargin);
                    p.height = Math.max(0, height * (item == null ? 1 : item.spanY) / layout.rows - p.topMargin - p.bottomMargin);
                }
                super.onMeasure(widthSpec, heightSpec);
            }
        };
    }

    private void fillPage(GridLayout target, int page, boolean primary) {
        target.removeAllViews();
        if (primary) homeCells.clear();
        target.setColumnCount(layout.columns);
        target.setRowCount(layout.rows);
        for (int slot = page * layout.pageSize(); slot < (page + 1) * layout.pageSize(); slot++) {
            final int selectedSlot = slot;
            HomeLayout.Item item = layout.get(slot);
            if (item == null && layout.ownerAt(slot) >= 0) continue;
            View cell;
            if (item != null && item.isWidget()) cell = widgetCell(item, slot, primary);
            else {
                cell = cell(item);
                cell.setOnClickListener(view -> {
                    if (editing && item != null) showMenu(homeOverlay, view, item, new Location(HOME, selectedSlot, -1));
                    else if (item != null) activate(item, view, selectedSlot);
                    else if (editing) showAppPicker(selectedSlot, -1);
                });
                cell.setOnLongClickListener(view -> {
                    if (locked()) { message("桌面布局已锁定"); return true; }
                    if (item == null) enterEdit();
                    else { editing = true; tools.setVisibility(VISIBLE); startItemDrag(view, item, selectedSlot, -1); }
                    return true;
                });
                if (item != null) cell.setContentDescription(itemDescription(item));
            }
            if (editing && item == null) {
                GradientDrawable vacant = shape(0x08ffffff, 12, 0, 0);
                vacant.setStroke(dp(1), colors.dark ? 0x99a9d6e0 : 0xddffffff, dp(5), dp(4));
                cell.setBackground(vacant);
            }
            int local = slot % layout.pageSize();
            GridLayout.LayoutParams params = new GridLayout.LayoutParams(
                    GridLayout.spec(local / layout.columns, item == null ? 1 : item.spanY),
                    GridLayout.spec(local % layout.columns, item == null ? 1 : item.spanX));
            params.width = 0; params.height = 0;
            params.setMargins(dp(3), dp(3), dp(3), dp(3));
            cell.setTag(slot);
            target.addView(cell, params);
            if (primary) homeCells.put(slot, cell);
        }
    }

    private void updatePageDots() {
        StringBuilder dots = new StringBuilder();
        for (int p = 0; p < layout.pageCount(); p++) dots.append(p == currentPage ? " ● " : " · ");
        pages.setText(dots);
        pages.setContentDescription("桌面第 " + (currentPage + 1) + " 页，共 " + layout.pageCount() + " 页；点击下一页");
    }

    private View snapshot(View source) {
        if (source == null || source.getWidth() <= 0 || source.getHeight() <= 0) {
            View placeholder = new View(activity);
            placeholder.setBackground(shape(colors.dark ? 0xb3375a66 : 0xa3f2fdff, 22, 0, 0));
            return placeholder;
        }
        Bitmap bitmap = Bitmap.createBitmap(source.getWidth(), source.getHeight(), Bitmap.Config.ARGB_8888);
        source.draw(new Canvas(bitmap));
        ImageView image = new ImageView(activity);
        image.setImageBitmap(bitmap);
        image.setScaleType(ImageView.ScaleType.FIT_XY);
        return image;
    }

    private Cell cell(HomeLayout.Item item) {
        Cell cell = new Cell();
        cell.setOrientation(LinearLayout.VERTICAL);
        cell.setGravity(Gravity.TOP | Gravity.CENTER_HORIZONTAL);
        cell.setClickable(item != null);
        cell.setFocusable(item != null);
        cell.setPadding(dp(3), 0, dp(3), 0);
        cell.setBackgroundColor(Color.TRANSPARENT);
        if (item == null) return cell;
        int iconSize = preferences.iconSizeDp();
        cell.addView(itemIcon(item, iconSize), new LinearLayout.LayoutParams(dp(iconSize), dp(iconSize)));
        TextView name = text(itemLabel(item), preferences.labelSizeSp(),
                itemAvailable(item) ? colors.ink : colors.muted);
        name.setGravity(Gravity.CENTER);
        name.setIncludeFontPadding(false);
        name.setMaxLines(1);
        name.setEllipsize(android.text.TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams nameParams = new LinearLayout.LayoutParams(-1, -2);
        nameParams.topMargin = dp(3);
        cell.addView(name, nameParams);
        return cell;
    }

    private View itemIcon(HomeLayout.Item item, int sizeDp) {
        int size = dp(sizeDp);
        if (HomeLayout.Item.ASSISTANT.equals(item.type)) {
            ImageView star = new ImageView(activity);
            star.setImageDrawable(new ChatIcon("sparkles", colors.accent));
            star.setPadding(dp(10), dp(10), dp(10), dp(10));
            star.setBackground(shape(colors.surface, 14, 0, 0));
            return star;
        }
        if (item.isFolder()) return folderIcon(item, size);
        FrameLayout frame = new FrameLayout(activity);
        Drawable icon = item.isShortcut() ? shortcutIcon(item) : appIcon(item.packageName, item.className);
        ImageView image = new ImageView(activity);
        image.setImageDrawable(icon);
        image.setAlpha(icon == null ? .35f : 1f);
        if (icon == null) image.setBackground(shape(colors.panel, 13, 1, colors.border));
        frame.addView(image, new FrameLayout.LayoutParams(-1, -1));
        if (item.isShortcut()) {
            ImageView badge = new ImageView(activity);
            badge.setImageDrawable(appIcon(item.packageName, null));
            badge.setBackground(shape(colors.surface, 6, 1, colors.surface));
            FrameLayout.LayoutParams badgeParams = new FrameLayout.LayoutParams(
                    Math.max(dp(17), size / 3), Math.max(dp(17), size / 3),
                    Gravity.END | Gravity.BOTTOM);
            frame.addView(badge, badgeParams);
        }
        return frame;
    }

    private View folderIcon(HomeLayout.Item folder, int size) {
        FrameLayout frame = new FrameLayout(activity) {
            @Override protected void onMeasure(int widthSpec, int heightSpec) {
                int side = MeasureSpec.getSize(widthSpec);
                int miniature = Math.round(side * .34f), margin = Math.round(side * .12f);
                int stride = side - margin * 2 - miniature;
                for (int i = 0; i < getChildCount(); i++) if (getChildAt(i) instanceof ImageView) {
                    FrameLayout.LayoutParams p = (FrameLayout.LayoutParams) getChildAt(i).getLayoutParams();
                    p.width = p.height = miniature;
                    p.leftMargin = margin + (i % 2) * stride;
                    p.topMargin = margin + (i / 2) * stride;
                }
                super.onMeasure(widthSpec, heightSpec);
            }
        };
        frame.setBackground(shape(colors.dark ? 0xcc294f5d : 0xccdff4fa, 14, 1, colors.border));
        frame.setClipToOutline(true);
        for (int index = 0; index < Math.min(4, folder.children.size()); index++) {
            HomeLayout.Item child = folder.children.get(index);
            ImageView icon = new ImageView(activity);
            icon.setImageDrawable(child.isShortcut() ? shortcutIcon(child) : appIcon(child.packageName, child.className));
            frame.addView(icon, new FrameLayout.LayoutParams(0, 0));
        }
        if (folder.children.isEmpty()) {
            android.widget.ImageView empty = new android.widget.ImageView(activity);
            empty.setImageDrawable(DesktopMenu.icon(DesktopMenu.Glyph.FOLDER, colors.muted));
            empty.setPadding(dp(12), dp(12), dp(12), dp(12));
            empty.setBackground(frame.getBackground());
            return empty;
        }
        return frame;
    }

    private void activate(HomeLayout.Item item, View source, int slot) {
        if (item == null) {
            showAppPicker(slot, -1);
        } else if (HomeLayout.Item.ASSISTANT.equals(item.type)) {
            assistantAction.run();
        } else if (item.isFolder()) {
            openFolder(slot);
        } else if (HomeLayout.Item.APP.equals(item.type)) {
            launchApp(item);
        } else {
            startShortcut(item, source);
        }
    }

    private void showMenu(FrameLayout parent, View anchor, HomeLayout.Item item, Location location) {
        dismissMenu();
        FrameLayout host = location.kind == HOME ? activity.findViewById(android.R.id.content) : parent;
        menu = new DesktopMenu(host, anchor, itemIcon(item, 56), buildMenu(item, location), this::dismissMenu);
    }

    private LinearLayout buildMenu(HomeLayout.Item item, Location location) {
        LinearLayout panel = column();
        panel.setPadding(0, dp(4), 0, dp(8));
        if (HomeLayout.Item.ASSISTANT.equals(item.type)) {
            addAction(panel, DesktopMenu.Glyph.REMOVE, "从桌面移除", () -> { layout.remove(location.slot); persist(); });
            return panel;
        }
        if (item.isFolder()) {
            TextView heading = text(item.name, 14, colors.muted);
            heading.setPadding(dp(18), dp(10), dp(18), dp(8));
            panel.addView(heading);
            addAction(panel, DesktopMenu.Glyph.FOLDER, tr("打开文件夹", "Open folder"),
                    () -> openFolder(location.slot));
            addAction(panel, DesktopMenu.Glyph.RENAME, tr("重命名", "Rename"), () -> renameFolder(location.slot));
            addAction(panel, DesktopMenu.Glyph.ADD, tr("批量添加应用", "Add apps"), () -> batchAdd(location.slot));
            addDivider(panel);
            addAction(panel, DesktopMenu.Glyph.DELETE, tr("删除文件夹", "Delete folder"), () -> deleteFolder(location.slot));
            return panel;
        }

        LinearLayout systemActions = row();
        systemActions.setPadding(dp(8), 0, dp(8), 0);
        addSystemAction(systemActions, DesktopMenu.Glyph.INFO, tr("应用信息", "App info"), () -> open(new Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + item.packageName))));
        addSystemAction(systemActions, DesktopMenu.Glyph.DELETE, tr("卸载", "Uninstall"), () -> open(new Intent(
                Intent.ACTION_DELETE, Uri.parse("package:" + item.packageName))));
        if (location.kind == ALL_APPS) {
            addSystemAction(systemActions, DesktopMenu.Glyph.PIN, tr("固定到首页或文件夹", "Pin to Home or folder"),
                    () -> chooseDestination(item, null));
        } else {
            addSystemAction(systemActions, DesktopMenu.Glyph.REMOVE,
                    location.kind == HOME ? tr("从首页移除", "Remove from Home") : tr("从文件夹移除", "Remove from folder"), () -> {
                        if (location.kind == HOME) layout.remove(location.slot);
                        else layout.removeFromFolder(location.slot, location.child);
                        persist();
                        renderFolder();
                    });
        }
        panel.addView(systemActions);
        addDivider(panel);
        boolean hasShortcuts = addShortcutActions(panel, item, location);
        if (location.kind != ALL_APPS && hasShortcuts) addDivider(panel);
        if (location.kind == HOME) {
            addAction(panel, DesktopMenu.Glyph.REPLACE, tr("替换应用", "Replace app"), () -> showAppPicker(location.slot, -1));
            addAction(panel, DesktopMenu.Glyph.FOLDER, tr("创建文件夹", "Create folder"), () -> createFolder(location.slot));
        } else if (location.kind == FOLDER) {
            addAction(panel, DesktopMenu.Glyph.REPLACE, tr("移出文件夹", "Move out of folder"),
                    () -> chooseFolderDestination(location.slot, location.child));
        }
        return panel;
    }

    private boolean addShortcutActions(LinearLayout panel, HomeLayout.Item owner, Location location) {
        ResolveInfo app = resolveApp(owner.packageName,
                HomeLayout.Item.APP.equals(owner.type) ? owner.className : null);
        if (app == null) return false;
        if (!shortcuts.hasAccess()) {
            addAction(panel, DesktopMenu.Glyph.INFO, tr("启用应用快捷功能", "Enable app shortcuts"), this::promptDefaultHome);
            return true;
        }
        List<ShortcutInfo> available;
        try {
            ShortcutInfo selected = resolveShortcut(owner);
            ComponentName activityName = selected != null && selected.getActivity() != null
                    ? selected.getActivity()
                    : new ComponentName(app.activityInfo.packageName, app.activityInfo.name);
            available = shortcuts.query(activityName);
        } catch (RuntimeException failure) {
            TextView unavailable = text(tr("无法读取快捷功能：", "Could not read shortcuts: ")
                    + failure.getMessage(), 13, colors.muted);
            unavailable.setPadding(dp(18), dp(8), dp(18), dp(8));
            panel.addView(unavailable);
            return true;
        }
        for (ShortcutInfo shortcut : available) {
            LinearLayout row = row();
            LinearLayout launch = row();
            launch.setPadding(dp(18), 0, 0, 0);
            launch.setBackground(DesktopMenu.ripple(0x16202521));
            launch.setContentDescription(shortcutLabel(shortcut));
            launch.setFocusable(true);
            launch.setOnClickListener(view -> startShortcut(shortcut, view));
            ImageView icon = new ImageView(activity);
            icon.setImageDrawable(shortcutIcon(shortcut));
            launch.addView(icon, new LinearLayout.LayoutParams(dp(24), dp(24)));
            TextView title = text(shortcutLabel(shortcut), 16, shortcut.isEnabled() ? colors.ink : colors.muted);
            title.setPadding(dp(14), 0, dp(4), 0);
            title.setMaxLines(1);
            title.setEllipsize(android.text.TextUtils.TruncateAt.END);
            launch.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
            row.addView(launch, new LinearLayout.LayoutParams(0, dp(50), 1));
            ImageView pin = menuIconButton(DesktopMenu.Glyph.PIN,
                    tr("固定快捷功能：", "Pin shortcut: ") + shortcutLabel(shortcut),
                    () -> pinShortcut(shortcut, location.kind == FOLDER ? location.slot : -1));
            row.addView(pin, new LinearLayout.LayoutParams(dp(48), dp(50)));
            panel.addView(row);
        }
        return !available.isEmpty();
    }

    boolean dismissMenu() {
        if (menu == null) return false;
        DesktopMenu closing = menu;
        menu = null;
        closing.dismiss();
        return true;
    }

    private void createFolder(int slot) {
        HomeLayout.Item item = layout.get(slot);
        if (item == null || item.isFolder()) return;
        layout.set(slot, HomeLayout.Item.folder(tr("文件夹", "Folder"), List.of(item)));
        persist();
        openFolder(slot);
    }

    private void renameFolder(int slot) {
        if (locked()) { message("桌面布局已锁定"); return; }
        dismissMenu();
        HomeLayout.Item folder = layout.get(slot);
        if (folder == null || !folder.isFolder()) return;
        EditText name = new EditText(activity);
        name.setSingleLine(true);
        name.setText(folder.name);
        name.setSelectAllOnFocus(true);
        new AlertDialog.Builder(activity).setTitle(tr("文件夹名称", "Folder name"))
                .setView(name).setNegativeButton(tr("取消", "Cancel"), null)
                .setPositiveButton(tr("保存", "Save"), (dialog, which) -> {
                    if (!layout.renameFolder(slot, name.getText().toString())) {
                        message(tr("名称不能为空。", "The name cannot be empty."));
                        return;
                    }
                    persist();
                    renderFolder();
                }).show();
    }

    private void deleteFolder(int slot) {
        dismissMenu();
        HomeLayout.Item folder = layout.get(slot);
        if (folder == null || !folder.isFolder()) return;
        new AlertDialog.Builder(activity).setTitle(tr("删除文件夹？", "Delete folder?"))
                .setMessage(tr("文件夹内的入口也会从桌面移除。", "Its items will also be removed from Home."))
                .setNegativeButton(tr("取消", "Cancel"), null)
                .setPositiveButton(tr("删除", "Delete"), (dialog, which) -> {
                    layout.remove(slot);
                    persist();
                    closeFolder();
                }).show();
    }

    private void batchAdd(int folderSlot) {
        if (locked()) { message("桌面布局已锁定"); return; }
        dismissMenu();
        String[] labels = new String[apps.size()];
        boolean[] selected = new boolean[apps.size()];
        for (int index = 0; index < apps.size(); index++) {
            labels[index] = apps.get(index).loadLabel(packages).toString();
        }
        new AlertDialog.Builder(activity).setTitle(tr("批量添加应用", "Add apps"))
                .setMultiChoiceItems(labels, selected, (dialog, which, checked) -> selected[which] = checked)
                .setNegativeButton(tr("取消", "Cancel"), null)
                .setPositiveButton(tr("添加", "Add"), (dialog, which) -> {
                    ArrayList<HomeLayout.Item> additions = new ArrayList<>();
                    for (int index = 0; index < selected.length; index++) if (selected[index]) {
                        ResolveInfo app = apps.get(index);
                        additions.add(HomeLayout.Item.app(
                                app.activityInfo.packageName, app.activityInfo.name));
                    }
                    if (layout.addAllToFolder(folderSlot, additions) > 0) {
                        persist();
                        renderFolder();
                    }
                }).show();
    }

    private void openFolder(int slot) {
        dismissMenu();
        if (layout.get(slot) == null || !layout.get(slot).isFolder()) return;
        closeFolder(false);
        FrameLayout host = activity.findViewById(android.R.id.content);
        folderBackdrop = Bitmap.createBitmap(Math.max(1, host.getWidth() / 4),
                Math.max(1, host.getHeight() / 4), Bitmap.Config.ARGB_8888);
        Canvas snapshot = new Canvas(folderBackdrop);
        snapshot.scale(folderBackdrop.getWidth() / (float) host.getWidth(),
                folderBackdrop.getHeight() / (float) host.getHeight());
        if (dragPreview != null) dragPreview.setVisibility(INVISIBLE);
        host.draw(snapshot);
        if (dragPreview != null) dragPreview.setVisibility(VISIBLE);
        activeFolderSlot = slot;
        folderRoot = new FrameLayout(activity);
        folderRoot.setOnTouchListener(new View.OnTouchListener() {
            View source;
            float downX, downY;
            boolean moved;

            @Override public boolean onTouch(View view, MotionEvent event) {
                if (event.getActionMasked() == MotionEvent.ACTION_DOWN) {
                    pager.setGestureBlocked(pager.gestureId(), true);
                    downX = event.getRawX();
                    downY = event.getRawY();
                    moved = false;
                    int target = homeTarget(downX, downY);
                    source = target >= 0 && layout.get(target) != null ? homeCells.get(target) : null;
                }
                if (Math.hypot(event.getRawX() - downX, event.getRawY() - downY) > touchSlop) moved = true;
                if (event.getActionMasked() == MotionEvent.ACTION_UP && !moved
                        && event.getEventTime() - event.getDownTime() < LONG_PRESS_MS) {
                    if (source != null) {
                        MotionEvent cancel = MotionEvent.obtain(event); cancel.setAction(MotionEvent.ACTION_CANCEL);
                        source.dispatchTouchEvent(cancel); cancel.recycle();
                    }
                    source = null; closeFolder(); return true;
                }
                if (source != null) {
                    int[] origin = new int[2];
                    source.getLocationOnScreen(origin);
                    MotionEvent forwarded = MotionEvent.obtain(event);
                    forwarded.setLocation(event.getRawX() - origin[0], event.getRawY() - origin[1]);
                    source.dispatchTouchEvent(forwarded);
                    forwarded.recycle();
                } else if (event.getActionMasked() == MotionEvent.ACTION_UP && !moved) closeFolder();
                if (event.getActionMasked() == MotionEvent.ACTION_UP
                        || event.getActionMasked() == MotionEvent.ACTION_CANCEL) source = null;
                return true;
            }
        });
        host.addView(folderRoot, new FrameLayout.LayoutParams(-1, -1));
        folderBack = new androidx.activity.OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                if (!dismissMenu()) closeFolder();
            }
        };
        ((androidx.activity.ComponentActivity) activity).getOnBackPressedDispatcher().addCallback(folderBack);
        folderOriginSlot = slot;
        folderClosing = false;
        renderFolder();
        playFolderOpen();
        if (dragPreview != null) dragPreview.bringToFront();
    }

    private void closeFolder() { closeFolder(true); }

    private void closeFolder(boolean animated) {
        if (folderRoot == null) return;
        if (folderClosing && animated) return;
        dismissMenu();
        if (!animated || !Motion.enabled() || folderSurface == null) {
            teardownFolder();
            return;
        }
        folderClosing = true;
        if (folderBackground != null) folderBackground.animate().alpha(0f).setDuration(Motion.LOCAL).start();
        folderSurface.animate().cancel();
        folderSurface.animate().translationX(folderFromX).translationY(folderFromY)
                .scaleX(folderFromScale).scaleY(folderFromScale).alpha(0f)
                .setDuration(Motion.PAGE).setInterpolator(Motion.EASE)
                .withEndAction(this::teardownFolder).start();
    }

    private void playFolderOpen() {
        if (folderSurface == null) return;
        folderSurface.setAlpha(0f);
        if (folderBackground != null) folderBackground.setAlpha(0f);
        folderSurface.post(() -> {
            if (folderSurface == null || folderClosing) return;
            View source = homeCells.get(folderOriginSlot);
            if (source != null && source.getWidth() > 0) {
                int[] from = new int[2], to = new int[2];
                source.getLocationOnScreen(from);
                folderSurface.getLocationOnScreen(to);
                folderFromX = from[0] + source.getWidth() / 2f - (to[0] + folderSurface.getWidth() / 2f);
                folderFromY = from[1] + source.getHeight() / 2f - (to[1] + folderSurface.getHeight() / 2f);
                folderFromScale = Math.max(.18f, source.getWidth() / (float) Math.max(1, folderSurface.getWidth()));
            } else {
                folderFromX = 0;
                folderFromY = dp(24);
                folderFromScale = .92f;
            }
            if (!Motion.enabled()) {
                folderSurface.setAlpha(1f);
                folderSurface.setTranslationX(0);
                folderSurface.setTranslationY(0);
                folderSurface.setScaleX(1f);
                folderSurface.setScaleY(1f);
                if (folderBackground != null) folderBackground.setAlpha(1f);
                return;
            }
            folderSurface.setTranslationX(folderFromX);
            folderSurface.setTranslationY(folderFromY);
            folderSurface.setScaleX(folderFromScale);
            folderSurface.setScaleY(folderFromScale);
            folderSurface.animate().translationX(0).translationY(0).scaleX(1f).scaleY(1f).alpha(1f)
                    .setDuration(Motion.PAGE).setInterpolator(Motion.EASE).start();
            if (folderBackground != null) folderBackground.animate().alpha(1f).setDuration(Motion.LOCAL).start();
        });
    }

    private void teardownFolder() {
        if (folderRoot == null) return;
        folderClosing = false;
        if (folderSurface != null) folderSurface.animate().cancel();
        if (folderBackground != null) folderBackground.animate().cancel();
        if (folderRoot.getParent() instanceof ViewGroup parent) parent.removeView(folderRoot);
        if (folderBack != null) folderBack.remove();
        folderBack = null;
        folderRoot = null;
        folderPanel = null;
        folderBackground = null; folderSurface = null;
        colors.applySystemBars(activity, Color.TRANSPARENT);
        pager.setGestureBlocked(pager.gestureId(), false);
        folderGrid = null;
        folderBackdrop = null;
        activeFolderSlot = -1;
        folderOriginSlot = -1;
    }

    private void sortFolders() {
        if (!"name".equals(preferences.folderSort())) return;
        java.text.Collator collator = java.text.Collator.getInstance();
        for (int i = 0; i < layout.size(); i++) {
            HomeLayout.Item item = layout.get(i);
            if (item == null || !item.isFolder()) continue;
            ArrayList<HomeLayout.Item> children = new ArrayList<>(item.children);
            children.sort((a, b) -> collator.compare(itemLabel(a), itemLabel(b)));
            if (!children.equals(item.children)) layout.set(i, HomeLayout.Item.folder(item.folderId, item.name, children));
        }
    }

    private void renderFolder() {
        sortFolders();
        layout.save();
        if (folderRoot == null || activeFolderSlot < 0) return;
        HomeLayout.Item folder = layout.get(activeFolderSlot);
        if (folder == null || !folder.isFolder()) {
            closeFolder();
            return;
        }
        dismissMenu();
        folderRoot.removeAllViews();
        folderRoot.setBackgroundColor(Color.TRANSPARENT);
        androidx.core.view.ViewCompat.setAccessibilityPaneTitle(folderRoot, folder.name);
        ImageView background = new ImageView(activity);
        background.setImageBitmap(folderBackdrop); background.setScaleType(ImageView.ScaleType.FIT_XY);
        background.setColorFilter(0x66233f50, android.graphics.PorterDuff.Mode.SRC_ATOP);
        if (Build.VERSION.SDK_INT >= 31)
            background.setRenderEffect(RenderEffect.createBlurEffect(dp(18), dp(18), Shader.TileMode.CLAMP));
        background.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        folderBackground = background;
        folderRoot.addView(background, new FrameLayout.LayoutParams(-1, -1));
        activity.getWindow().getDecorView().setSystemUiVisibility(0);
        folderPanel = new FrameLayout(activity);
        folderPanel.setBackground(shape(colors.dark ? 0xe6254553 : 0xcce6f7fc, 28, 1,
                colors.dark ? 0x66578293 : 0xb3ffffff));
        folderPanel.setClipToOutline(true); folderPanel.setElevation(dp(4)); folderPanel.setClickable(true);
        LinearLayout content = column();
        content.setPadding(dp(16), dp(12), dp(16), dp(12));
        TextView title = text(folder.name, 24, colors.ink);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        title.setGravity(Gravity.CENTER_VERTICAL);
        title.setPadding(dp(6), 0, dp(6), 0);
        title.setSingleLine(true);
        title.setEllipsize(android.text.TextUtils.TruncateAt.END);
        title.setContentDescription(tr("重命名文件夹 ", "Rename folder ") + folder.name);
        title.setFocusable(true);
        title.setOnClickListener(view -> renameFolder(activeFolderSlot));
        title.setOnLongClickListener(view -> {
            showMenu(folderRoot, view, folder, new Location(FOLDER, activeFolderSlot, -1));
            return true;
        });
        title.setMaxWidth(dp(220));
        LinearLayout titleRow = row(); titleRow.setGravity(Gravity.CENTER);
        titleRow.addView(title, new LinearLayout.LayoutParams(-2, dp(56)));
        ImageView rename = new ImageView(activity);
        rename.setImageDrawable(DesktopMenu.icon(DesktopMenu.Glyph.RENAME, colors.muted));
        rename.setPadding(dp(8), dp(14), dp(8), dp(14));
        rename.setContentDescription("重命名文件夹"); rename.setFocusable(true);
        rename.setOnClickListener(v -> renameFolder(activeFolderSlot));
        titleRow.addView(rename, new LinearLayout.LayoutParams(dp(40), dp(48)));
        content.addView(titleRow, new LinearLayout.LayoutParams(-1, dp(64)));

        folderGrid = new GridLayout(activity);
        folderGrid.setColumnCount(3);
        int rows = Math.max(2, (folder.children.size() + 3) / 3);
        for (int index = 0; index < rows * 3; index++) {
            final int childIndex = index;
            View entry;
            if (index < folder.children.size()) {
                HomeLayout.Item item = folder.children.get(index);
                Cell cell = cell(item);
                cell.setContentDescription(itemDescription(item));
                cell.setOnClickListener(view -> activate(item, view, activeFolderSlot));
                cell.setOnTouchListener(new FolderTouch(activeFolderSlot, childIndex, item, cell));
                cell.setOnLongClickListener(view -> {
                    showMenu(folderRoot, view, item, new Location(FOLDER, activeFolderSlot, childIndex));
                    return true;
                });
                entry = cell;
            } else if (index == folder.children.size()) {
                LinearLayout add = column(); add.setGravity(Gravity.TOP | Gravity.CENTER_HORIZONTAL);
                ImageView plus = new ImageView(activity);
                plus.setImageDrawable(new ChatIcon("plus", colors.muted));
                plus.setPadding(dp(15), dp(15), dp(15), dp(15));
                plus.setBackground(shape(colors.dark ? 0x663b6877 : 0x77ffffff, 14, 1, colors.border));
                add.addView(plus, new LinearLayout.LayoutParams(dp(preferences.iconSizeDp()), dp(preferences.iconSizeDp())));
                TextView name = text("添加应用", preferences.labelSizeSp(), colors.ink);
                name.setPadding(0, dp(3), 0, 0); name.setGravity(Gravity.CENTER); add.addView(name);
                add.setContentDescription("批量添加应用到文件夹"); add.setFocusable(true);
                add.setOnClickListener(v -> batchAdd(activeFolderSlot)); entry = add;
            } else {
                entry = new View(activity);
                entry.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
            }
            GridLayout.LayoutParams params = new GridLayout.LayoutParams(
                    GridLayout.spec(index / 3), GridLayout.spec(index % 3, 1f));
            params.width = 0;
            params.height = dp(112);
            folderGrid.addView(entry, params);
        }
        ScrollView scroll = new ScrollView(activity);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.addView(folderGrid, new ScrollView.LayoutParams(-1, -2));
        content.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        folderPanel.addView(content, new FrameLayout.LayoutParams(-1, -1));
        Rect safe = new Rect();
        folderRoot.getWindowVisibleDisplayFrame(safe);
        folderSurface = column();
        int panelHeight = Math.min(dp(88 + Math.min(3, rows) * 112), safe.height() - dp(96));
        folderSurface.addView(folderPanel, new LinearLayout.LayoutParams(-1, panelHeight));
        TextView hint = text("点击空白处收起", 13, 0xddeafaff);
        hint.setGravity(Gravity.CENTER); hint.setOnClickListener(v -> closeFolder());
        folderSurface.addView(hint, new LinearLayout.LayoutParams(-1, dp(44)));
        folderRoot.addView(folderSurface, new FrameLayout.LayoutParams(
                Math.min(dp(400), safe.width() - dp(48)), -2, Gravity.CENTER));
    }

    private void startDragPreview(HomeLayout.Item item) {
        clearDragPreview();
        FrameLayout host = activity.findViewById(android.R.id.content);
        dragPreview = itemIcon(item, 56);
        dragPreview.setElevation(dp(20));
        dragPreview.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        host.addView(dragPreview, new FrameLayout.LayoutParams(dp(56), dp(56)));
    }

    private void moveDragPreview(float rawX, float rawY) {
        int[] origin = new int[2];
        ((View) dragPreview.getParent()).getLocationOnScreen(origin);
        dragPreview.setX(rawX - origin[0] - dp(28));
        dragPreview.setY(rawY - origin[1] - dp(28));
    }

    private void clearDragPreview() {
        if (dragPreview == null) return;
        ((ViewGroup) dragPreview.getParent()).removeView(dragPreview);
        dragPreview = null;
    }

    private void restoreFolderSurface() {
        if (folderRoot == null) return;
        folderBackground.setAlpha(1f);
        folderSurface.setAlpha(1f);
    }

    private final class FolderTouch implements View.OnTouchListener {
        final int folderSlot;
        final int child;
        final HomeLayout.Item item;
        final View view;
        final Runnable longPress;
        float downX;
        float downY;
        boolean longPressed;
        boolean dragging;
        boolean moved;
        boolean outsideFolder;

        FolderTouch(int folderSlot, int child, HomeLayout.Item item, View view) {
            this.folderSlot = folderSlot;
            this.child = child;
            this.item = item;
            this.view = view;
            longPress = () -> {
                if (folderRoot == null || locked()) return;
                longPressed = true;
                view.getParent().requestDisallowInterceptTouchEvent(true);
                view.performLongClick();
            };
        }

        @Override public boolean onTouch(View ignored, MotionEvent event) {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    pager.setGestureBlocked(pager.gestureId(), true);
                    downX = event.getRawX();
                    downY = event.getRawY();
                    longPressed = dragging = moved = false;
                    handler.postDelayed(longPress, LONG_PRESS_MS);
                    return true;
                case MotionEvent.ACTION_MOVE:
                    if (!longPressed) {
                        if (distance(event) > touchSlop) {
                            moved = true;
                            handler.removeCallbacks(longPress);
                        }
                        return true;
                    }
                    if (!dragging && distance(event) > touchSlop) {
                        dragging = true;
                        dismissMenu();
                        view.setAlpha(.28f);
                        outsideFolder = false;
                        startDragPreview(item);
                    }
                    if (dragging) {
                        moveDragPreview(event.getRawX(), event.getRawY());
                        if (!contains(folderPanel, event.getRawX(), event.getRawY())) outsideFolder = true;
                        folderBackground.setAlpha(outsideFolder ? 0f : 1f);
                        folderSurface.setAlpha(outsideFolder ? 0f : 1f);
                        if (!outsideFolder) clearDropTarget();
                        else {
                            highlightDrop(homeTarget(event.getRawX(), event.getRawY()), false);
                            int[] origin = new int[2]; HomeDesktop.this.getLocationOnScreen(origin);
                            int direction = event.getRawX() - origin[0] < dp(28) ? -1
                                    : event.getRawX() - origin[0] > getWidth() - dp(28) ? 1 : 0;
                            if (direction != edgeDirection) {
                                handler.removeCallbacks(edgeTurn); edgeDirection = direction;
                                if (direction != 0) handler.postDelayed(edgeTurn, 650);
                            }
                        }
                    }
                    return true;
                case MotionEvent.ACTION_UP:
                    handler.removeCallbacks(longPress);
                    if (dragging) finishFolderDrag(event);
                    else if (!longPressed && !moved) view.performClick();
                    finishTouch();
                    return true;
                case MotionEvent.ACTION_CANCEL:
                    handler.removeCallbacks(longPress);
                    finishTouch();
                    return true;
                default:
                    return true;
            }
        }

        private void finishTouch() {
            dragging = false;
            restoreFolderSurface();
            edgeDirection = 0; handler.removeCallbacks(edgeTurn);
            clearDropTarget();
            clearDragPreview();
            view.setAlpha(1f);
            if (view.getParent() != null) view.getParent().requestDisallowInterceptTouchEvent(false);
        }

        private float distance(MotionEvent event) {
            return (float) Math.hypot(event.getRawX() - downX, event.getRawY() - downY);
        }

        private void finishFolderDrag(MotionEvent event) {
            if (!outsideFolder) {
                if ("name".equals(preferences.folderSort())) {
                    message("当前按名称排序；请在桌面设置中切换为手动排序后拖动"); return;
                }
                int targetChild = childTarget(event.getRawX(), event.getRawY());
                if (targetChild >= 0 && layout.moveInFolder(folderSlot, child,
                        Math.min(targetChild, layout.get(folderSlot).children.size() - 1))) {
                    persist();
                    renderFolder();
                }
                return;
            }
            int targetSlot = homeTarget(event.getRawX(), event.getRawY());
            if (targetSlot < 0) return;
            HomeLayout.Item target = layout.get(targetSlot);
            if (target != null && target.isFolder() && !centerHit(
                    homeCells.get(targetSlot), event.getRawX(), event.getRawY())) return;
            if (!layout.moveFromFolder(folderSlot, child, targetSlot)) {
                message(tr("该位置已占用；请从菜单显式选择替换或文件夹。",
                        "That position is occupied; choose a replacement or folder from the menu."));
                return;
            }
            persist();
            closeFolder();
        }
    }

    private Dialog desktopDialog() {
        androidx.activity.ComponentDialog dialog = new androidx.activity.ComponentDialog(activity);
        dialog.getOnBackPressedDispatcher().addCallback(dialog, new androidx.activity.OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                if (!dismissMenu()) dialog.cancel();
            }
        });
        return dialog;
    }

    private void showAppPicker(int targetSlot, int folderSlot) {
        dismissMenu();
        if (appDialog != null) appDialog.dismiss();
        appDialog = desktopDialog();
        FrameLayout root = new FrameLayout(activity);
        root.setBackgroundColor(colors.surface);
        LinearLayout content = column();
        content.setPadding(dp(18), dp(12), dp(18), dp(18));
        LinearLayout header = row();
        TextView title = text(targetSlot >= 0 ? tr("选择应用", "Choose an app")
                : folderSlot >= 0 ? tr("添加应用", "Add an app")
                : tr("全部应用", "All apps"), 22, colors.ink);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        header.addView(title, new LinearLayout.LayoutParams(0, dp(56), 1));
        TextView close = compact("×", () -> appDialog.dismiss());
        close.setTextSize(26);
        header.addView(close);
        content.addView(header);
        EditText query = new EditText(activity);
        query.setHint(tr("搜索应用", "Search apps"));
        query.setSingleLine(true);
        query.setTextColor(colors.ink);
        query.setHintTextColor(colors.muted);
        query.setBackground(shape(colors.panel, 24, 0, 0));
        query.setPadding(dp(16), 0, dp(16), 0);
        content.addView(query, new LinearLayout.LayoutParams(-1, dp(50)));
        TextView count = text(tr("全部应用 · ", "All apps · ") + apps.size(), 14, colors.muted);
        count.setPadding(dp(4), dp(12), dp(4), dp(6));
        content.addView(count);
        GridView results = new GridView(activity);
        results.setNumColumns(4);
        results.setStretchMode(GridView.STRETCH_COLUMN_WIDTH);
        results.setSelector(android.R.color.transparent);
        AppAdapter adapter = new AppAdapter();
        results.setAdapter(adapter);
        results.setOnItemClickListener((parent, view, position, id) -> {
            HomeLayout.Item item = adapter.item(position);
            if (targetSlot >= 0) {
                layout.set(targetSlot, item);
                persist();
                appDialog.dismiss();
            } else if (folderSlot >= 0) {
                layout.addToFolder(folderSlot, item);
                persist();
                appDialog.dismiss();
                renderFolder();
            } else launchApp(item);
        });
        results.setOnItemLongClickListener((parent, view, position, id) -> {
            showMenu(root, view, adapter.item(position), new Location(ALL_APPS, -1, -1));
            return true;
        });
        results.setOnScrollListener(new AbsListView.OnScrollListener() {
            @Override public void onScrollStateChanged(AbsListView view, int state) {
                if (state != SCROLL_STATE_IDLE) dismissMenu();
            }
            @Override public void onScroll(AbsListView view, int first, int visible, int total) { }
        });
        content.addView(results, new LinearLayout.LayoutParams(-1, 0, 1));
        query.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            @Override public void afterTextChanged(Editable s) { }
            @Override public void onTextChanged(CharSequence s, int start, int before, int countValue) {
                dismissMenu();
                adapter.filter(s.toString());
                results.setSelection(0);
                count.setText((s.toString().trim().isEmpty() ? tr("全部应用 · ", "All apps · ")
                        : tr("搜索结果 · ", "Results · ")) + adapter.getCount());
                count.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
            }
        });
        root.addView(content, new FrameLayout.LayoutParams(-1, -1));
        content.setFocusableInTouchMode(true);
        content.requestFocus();
        appDialog.setContentView(root);
        appDialog.setOnDismissListener(dialog -> {
            dismissMenu();
            appDialog = null;
        });
        appDialog.show();
        Window window = appDialog.getWindow();
        if (window != null) {
            WindowManager.LayoutParams params = window.getAttributes();
            params.width = WindowManager.LayoutParams.MATCH_PARENT;
            params.height = WindowManager.LayoutParams.MATCH_PARENT;
            window.setAttributes(params);
            window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
                    | WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN);
        }
    }

    private final class AppAdapter extends BaseAdapter {
        final List<ResolveInfo> catalog = List.copyOf(apps);
        final ArrayList<ResolveInfo> visible = new ArrayList<>(catalog);
        final HashMap<ResolveInfo, String> labels = new HashMap<>();

        @Override public int getCount() { return visible.size(); }
        @Override public ResolveInfo getItem(int position) { return visible.get(position); }
        @Override public long getItemId(int position) { return position; }

        HomeLayout.Item item(int position) {
            ResolveInfo app = getItem(position);
            return HomeLayout.Item.app(app.activityInfo.packageName, app.activityInfo.name);
        }

        String label(ResolveInfo app) {
            return labels.computeIfAbsent(app, value -> value.loadLabel(packages).toString());
        }

        void filter(String query) {
            visible.clear();
            for (ResolveInfo app : catalog) {
                if (query.trim().isEmpty() || AppSearch.matches(label(app), app.activityInfo.packageName, query)) {
                    visible.add(app);
                }
            }
            notifyDataSetChanged();
        }

        @Override public View getView(int position, View convertView, ViewGroup parent) {
            Cell cell = (Cell) convertView;
            if (cell == null) {
                cell = cell(null);
                cell.setLayoutParams(new AbsListView.LayoutParams(-1, dp(116)));
                ImageView icon = new ImageView(activity);
                cell.addView(icon, new LinearLayout.LayoutParams(dp(52), dp(52)));
                TextView name = text("", 13, colors.ink);
                name.setGravity(Gravity.CENTER);
                name.setMaxLines(2);
                name.setEllipsize(android.text.TextUtils.TruncateAt.END);
                LinearLayout.LayoutParams nameParams = new LinearLayout.LayoutParams(-1, -2);
                nameParams.topMargin = dp(3);
                cell.addView(name, nameParams);
            }
            ResolveInfo app = getItem(position);
            ((ImageView) cell.getChildAt(0)).setImageDrawable(app.loadIcon(packages));
            ((TextView) cell.getChildAt(1)).setText(label(app));
            cell.setContentDescription(tr("打开 ", "Open ") + label(app));
            return cell;
        }
    }

    private void pinShortcut(ShortcutInfo shortcut, int folderSlot) {
        HomeLayout.Item item = HomeLayout.Item.shortcut(shortcut.getPackage(), shortcut.getId(),
                shortcuts.userSerial(shortcut));
        if (folderSlot >= 0) {
            try {
                shortcuts.pin(shortcut);
                if (layout.addToFolder(folderSlot, item)) {
                    persist();
                    renderFolder();
                }
            } catch (RuntimeException failure) {
                message(tr("无法固定快捷功能：", "Could not pin shortcut: ") + failure.getMessage());
            }
        } else {
            chooseDestination(item, () -> shortcuts.pin(shortcut));
        }
    }

    private void chooseDestination(HomeLayout.Item item, BeforeCommit beforeCommit) {
        if (locked()) { message("桌面布局已锁定"); return; }
        dismissMenu();
        ArrayList<Destination> destinations = new ArrayList<>();
        ArrayList<String> labels = new ArrayList<>();
        for (int slot = 0; slot < layout.size(); slot++) {
            if (layout.ownerAt(slot) >= 0 && layout.ownerAt(slot) != slot) continue;
            HomeLayout.Item existing = layout.get(slot);
            if (existing != null && existing.isWidget()) continue;
            if (existing == null) {
                destinations.add(new Destination(slot, false));
                labels.add(tr("位置 ", "Position ") + (slot + 1) + tr("（空）", " (empty)"));
            } else if (existing.isFolder()) {
                destinations.add(new Destination(slot, true));
                labels.add(tr("加入文件夹：", "Add to folder: ") + existing.name);
            } else {
                destinations.add(new Destination(slot, false));
                labels.add(tr("替换位置 ", "Replace position ") + (slot + 1)
                        + " · " + itemLabel(existing));
            }
        }
        new AlertDialog.Builder(activity).setTitle(layout.isFull()
                ? tr("桌面已满，请明确选择", "Home is full; choose explicitly")
                : tr("固定到首页或文件夹", "Pin to Home or folder"))
                .setItems(labels.toArray(new String[0]), (dialog, which) -> {
                    Destination destination = destinations.get(which);
                    String destinationLabel = labels.get(which);
                    new AlertDialog.Builder(activity).setTitle(tr("确认固定？", "Confirm pin?"))
                            .setMessage(destinationLabel)
                            .setNegativeButton(tr("取消", "Cancel"), null)
                            .setPositiveButton(tr("确认", "Confirm"), (confirm, button) -> {
                                try {
                                    if (beforeCommit != null) beforeCommit.run();
                                    if (destination.folder) layout.addToFolder(destination.slot, item);
                                    else layout.set(destination.slot, item);
                                    persist();
                                    if (appDialog != null) appDialog.dismiss();
                                    renderFolder();
                                } catch (RuntimeException failure) {
                                    message(tr("固定失败，桌面未更改：", "Pin failed; Home was not changed: ")
                                            + failure.getMessage());
                                }
                            }).show();
                }).setNegativeButton(tr("取消", "Cancel"), null).show();
    }

    private void chooseFolderDestination(int folderSlot, int childIndex) {
        dismissMenu();
        HomeLayout.Item folder = layout.get(folderSlot);
        if (folder == null || !folder.isFolder() || childIndex < 0
                || childIndex >= folder.children.size()) return;
        HomeLayout.Item moving = folder.children.get(childIndex);
        ArrayList<Destination> destinations = new ArrayList<>();
        ArrayList<String> labels = new ArrayList<>();
        for (int slot = 0; slot < layout.size(); slot++) {
            if (slot == folderSlot) continue;
            if (layout.ownerAt(slot) >= 0 && layout.ownerAt(slot) != slot) continue;
            HomeLayout.Item existing = layout.get(slot);
            if (existing != null && existing.isWidget()) continue;
            destinations.add(new Destination(slot, existing != null && existing.isFolder()));
            labels.add(existing == null ? tr("位置 ", "Position ") + (slot + 1) + tr("（空）", " (empty)")
                    : existing.isFolder() ? tr("加入文件夹：", "Add to folder: ") + existing.name
                    : tr("替换位置 ", "Replace position ") + (slot + 1) + " · " + itemLabel(existing));
        }
        new AlertDialog.Builder(activity).setTitle(tr("移出文件夹", "Move out of folder"))
                .setItems(labels.toArray(new String[0]), (dialog, which) -> {
                    Destination destination = destinations.get(which);
                    String destinationLabel = labels.get(which);
                    new AlertDialog.Builder(activity).setTitle(tr("确认移动？", "Confirm move?"))
                            .setMessage(destinationLabel)
                            .setNegativeButton(tr("取消", "Cancel"), null)
                            .setPositiveButton(tr("确认", "Confirm"), (confirm, button) -> {
                                if (destination.folder
                                        && !layout.addToFolder(destination.slot, moving)) return;
                                if (!destination.folder) layout.set(destination.slot, moving);
                                layout.removeFromFolder(folderSlot, childIndex);
                                persist();
                                renderFolder();
                            }).show();
                }).setNegativeButton(tr("取消", "Cancel"), null).show();
    }

    private void persist() {
        sortFolders();
        layout.save();
        syncPins();
        render();
    }

    private int homeTarget(float rawX, float rawY) {
        if (!contains(grid, rawX, rawY)) return -1;
        int[] origin = new int[2]; grid.getLocationOnScreen(origin);
        int x = Math.min(layout.columns - 1, (int) ((rawX - origin[0]) * layout.columns / Math.max(1, grid.getWidth())));
        int y = Math.min(layout.rows - 1, (int) ((rawY - origin[1]) * layout.rows / Math.max(1, grid.getHeight())));
        return currentPage * layout.pageSize() + y * layout.columns + x;
    }

    private int childTarget(float rawX, float rawY) {
        if (folderGrid == null) return -1;
        for (int index = 0; index < folderGrid.getChildCount(); index++) {
            if (contains(folderGrid.getChildAt(index), rawX, rawY)) return index;
        }
        return -1;
    }

    private boolean contains(View view, float rawX, float rawY) {
        Rect bounds = new Rect();
        return view.getGlobalVisibleRect(bounds) && bounds.contains((int) rawX, (int) rawY);
    }

    private boolean centerHit(View view, float rawX, float rawY) {
        if (view == null) return false;
        int[] position = new int[2];
        view.getLocationOnScreen(position);
        float centerX = position[0] + view.getWidth() / 2f;
        float centerY = position[1] + view.getHeight() / 2f;
        return Math.abs(rawX - centerX) <= view.getWidth() * .28f
                && Math.abs(rawY - centerY) <= view.getHeight() * .28f;
    }

    private void highlightDrop(int slot, boolean merge) {
        View target = slot < 0 ? null : homeCells.get(slot);
        if (dropTarget == target && target != null) {
            target.setBackground(shape(merge ? 0x33267a69 : 0x14267a69,
                    18, merge ? 2 : 1, colors.accent));
            return;
        }
        clearDropTarget();
        dropTarget = target;
        if (target != null) target.setBackground(shape(0x14267a69, 18, 1, colors.accent));
    }

    private void clearDropTarget() {
        if (dropTarget != null) dropTarget.setBackgroundColor(Color.TRANSPARENT);
        dropTarget = null;
    }

    private void launchApp(HomeLayout.Item item) {
        ResolveInfo app = resolveApp(item.packageName, item.className);
        if (app == null) {
            message(tr("应用暂不可用；仅在确认卸载后才会清理入口。",
                    "The app is temporarily unavailable; its entry is removed only after confirmed uninstall."));
            return;
        }
        open(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
                .setComponent(new ComponentName(item.packageName, item.className))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED));
    }

    private void startShortcut(HomeLayout.Item item, View source) {
        ShortcutInfo shortcut;
        try {
            shortcut = shortcuts.resolve(item.packageName, item.shortcutId, item.userSerial);
        } catch (RuntimeException failure) {
            message(tr("无法读取快捷功能；入口已保留：", "Could not read shortcut; the entry was kept: ")
                    + failure.getMessage());
            return;
        }
        if (shortcut == null) {
            message(tr("快捷功能暂时无法读取，入口会保留。", "The shortcut is temporarily unavailable; its entry will be kept."));
            return;
        }
        startShortcut(shortcut, source);
    }

    private void startShortcut(ShortcutInfo shortcut, View source) {
        if (!shortcut.isEnabled()) {
            message(tr("快捷功能已停用：", "The shortcut is disabled: ")
                    + disabledReason(shortcut.getDisabledReason())
                    + tr("。入口会保留。", ". Its entry will be kept."));
            return;
        }
        try {
            Rect bounds = new Rect();
            source.getGlobalVisibleRect(bounds);
            shortcuts.start(shortcut, bounds);
            AppLaunchHistory.record(activity, shortcut.getActivity());
            dismissMenu();
            exitEdit();
        } catch (RuntimeException failure) {
            message(tr("无法启动快捷功能：", "Could not start shortcut: ") + failure.getMessage());
        }
    }

    private String disabledReason(int reason) {
        return switch (reason) {
            case ShortcutInfo.DISABLED_REASON_BY_APP -> tr("所属应用已停用它", "disabled by its app");
            case ShortcutInfo.DISABLED_REASON_APP_CHANGED -> tr("所属应用已变更", "the app changed");
            case ShortcutInfo.DISABLED_REASON_VERSION_LOWER -> tr("当前应用版本过旧", "the installed app version is too old");
            case ShortcutInfo.DISABLED_REASON_BACKUP_NOT_SUPPORTED -> tr("无法从备份恢复", "it cannot be restored from backup");
            case ShortcutInfo.DISABLED_REASON_SIGNATURE_MISMATCH -> tr("应用签名不匹配", "the app signature does not match");
            case ShortcutInfo.DISABLED_REASON_OTHER_RESTORE_ISSUE -> tr("恢复失败", "restore failed");
            default -> tr("系统未提供具体原因", "the system did not provide a reason");
        };
    }

    private ShortcutInfo resolveShortcut(HomeLayout.Item item) {
        if (!item.isShortcut() || !shortcuts.hasAccess()) return null;
        try {
            return shortcuts.resolve(item.packageName, item.shortcutId, item.userSerial);
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    private Drawable shortcutIcon(HomeLayout.Item item) {
        ShortcutInfo shortcut = resolveShortcut(item);
        return shortcut == null ? null : shortcutIcon(shortcut);
    }

    private Drawable shortcutIcon(ShortcutInfo shortcut) {
        try {
            return shortcuts.icon(shortcut, getResources().getDisplayMetrics().densityDpi);
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    private Drawable appIcon(String packageName, String className) {
        ResolveInfo app = resolveApp(packageName, className);
        if (app != null) return iconPack.icon(new ComponentName(app.activityInfo.packageName, app.activityInfo.name), app.loadIcon(packages));
        try {
            return packages.getApplicationIcon(packageName);
        } catch (PackageManager.NameNotFoundException ignored) {
            return null;
        }
    }

    private ResolveInfo resolveApp(String packageName, String className) {
        ResolveInfo packageFallback = null;
        for (ResolveInfo app : apps) if (packageName.equals(app.activityInfo.packageName)) {
            if (className == null || className.equals(app.activityInfo.name)) return app;
            if (packageFallback == null) packageFallback = app;
        }
        return className == null ? packageFallback : null;
    }

    private String itemLabel(HomeLayout.Item item) {
        if (HomeLayout.Item.ASSISTANT.equals(item.type)) return "e助手";
        if (item.isWidget()) return "小组件";
        if (item.isFolder()) return item.name;
        if (item.isShortcut()) {
            ShortcutInfo shortcut = resolveShortcut(item);
            return shortcut == null ? item.shortcutId + tr("（暂不可用）", " (unavailable)")
                    : shortcutLabel(shortcut);
        }
        ResolveInfo app = resolveApp(item.packageName, item.className);
        return app == null ? item.packageName : app.loadLabel(packages).toString();
    }

    private String shortcutLabel(ShortcutInfo shortcut) {
        CharSequence label = shortcut.getShortLabel();
        return label == null || label.length() == 0 ? shortcut.getId() : label.toString();
    }

    private boolean itemAvailable(HomeLayout.Item item) {
        if (item.isFolder() || item.isWidget() || HomeLayout.Item.ASSISTANT.equals(item.type)) return true;
        if (item.isShortcut()) {
            ShortcutInfo shortcut = resolveShortcut(item);
            return shortcut != null && shortcut.isEnabled();
        }
        return resolveApp(item.packageName, item.className) != null;
    }

    private String itemDescription(HomeLayout.Item item) {
        if (item.isFolder()) return tr("打开文件夹 ", "Open folder ") + item.name;
        if (item.isShortcut()) return tr("启动快捷功能 ", "Start shortcut ") + itemLabel(item)
                + tr("，所属应用 ", ", app ") + item.packageName;
        return tr("打开 ", "Open ") + itemLabel(item);
    }

    private void promptDefaultHome() {
        new AlertDialog.Builder(activity).setTitle(tr("需要默认桌面资格", "Default Home access required"))
                .setMessage(tr("设为默认桌面后，才能读取和固定应用快捷功能。现有入口不会被删除。",
                        "Set this app as default Home to read and pin app shortcuts. Existing entries are kept."))
                .setNegativeButton(tr("取消", "Cancel"), null)
                .setPositiveButton(tr("打开设置", "Open settings"), (dialog, which) ->
                        open(new Intent(Settings.ACTION_HOME_SETTINGS))).show();
    }

    private void open(Intent intent) {
        try {
            activity.startActivity(intent);
            if (intent.hasCategory(Intent.CATEGORY_LAUNCHER))
                AppLaunchHistory.record(activity, intent.getComponent());
            exitEdit();
        } catch (ActivityNotFoundException | SecurityException failure) {
            message(tr("无法打开：", "Could not open: ") + failure.getClass().getSimpleName());
        }
    }

    private void message(String value) {
        Toast.makeText(activity, value == null ? tr("操作失败", "Action failed") : value,
                Toast.LENGTH_LONG).show();
    }

    private void addAction(LinearLayout parent, DesktopMenu.Glyph glyph, String label, Runnable action) {
        LinearLayout view = row();
        view.setPadding(dp(18), 0, dp(18), 0);
        view.setBackground(DesktopMenu.ripple(0x16202521));
        view.setContentDescription(label);
        view.setFocusable(true);
        view.setOnClickListener(ignored -> {
            dismissMenu();
            action.run();
        });
        ImageView icon = new ImageView(activity);
        icon.setImageDrawable(DesktopMenu.icon(glyph, colors.ink));
        view.addView(icon, new LinearLayout.LayoutParams(dp(22), dp(22)));
        TextView title = text(label, 14, colors.ink);
        title.setPadding(dp(14), 0, dp(4), 0);
        view.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
        ImageView arrow = new ImageView(activity);
        arrow.setImageDrawable(DesktopMenu.icon(DesktopMenu.Glyph.CHEVRON, colors.muted));
        view.addView(arrow, new LinearLayout.LayoutParams(dp(16), dp(16)));
        parent.addView(view, new LinearLayout.LayoutParams(-1, dp(48)));
    }

    private ImageView menuIconButton(DesktopMenu.Glyph glyph, String label, Runnable action) {
        ImageView view = new ImageView(activity);
        view.setImageDrawable(DesktopMenu.icon(glyph, colors.ink));
        view.setScaleType(ImageView.ScaleType.FIT_CENTER);
        view.setPadding(dp(14), dp(14), dp(14), dp(14));
        view.setBackground(DesktopMenu.ripple(0x16202521));
        view.setContentDescription(label);
        view.setTooltipText(label);
        view.setFocusable(true);
        view.setOnClickListener(ignored -> {
            dismissMenu();
            action.run();
        });
        return view;
    }

    private void addSystemAction(LinearLayout parent, DesktopMenu.Glyph glyph, String label, Runnable action) {
        parent.addView(menuIconButton(glyph, label, action), new LinearLayout.LayoutParams(0, dp(54), 1));
    }

    private void addDivider(LinearLayout parent) {
        View divider = new View(activity);
        divider.setBackgroundColor(colors.border);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(1));
        params.setMargins(dp(16), dp(4), dp(16), dp(4));
        parent.addView(divider, params);
    }

    private void toolbarIcon(TextView view, String name) {
        ChatIcon icon = new ChatIcon(name, colors.ink); icon.setBounds(0, 0, dp(18), dp(18));
        view.setCompoundDrawablesRelative(icon, null, null, null); view.setCompoundDrawablePadding(dp(5));
        view.setTextColor(colors.ink);
        view.setBackground(new android.graphics.drawable.InsetDrawable(shape(colors.dark ? 0x88456d7a : 0x668dccda, 20, 0, 0),
                0, dp(5), 0, dp(5)));
        view.setPadding(dp(12), 0, dp(12), 0);
    }

    private TextView compact(String label, Runnable action) {
        TextView view = text(label, 14, colors.accent);
        view.setGravity(Gravity.CENTER);
        view.setMinWidth(dp(48));
        view.setMinHeight(dp(48));
        view.setPadding(dp(10), 0, dp(10), 0);
        view.setBackground(shape(0x14267a69, 18, 0, 0));
        view.setClickable(true);
        view.setFocusable(true);
        view.setOnClickListener(ignored -> action.run());
        Motion.press(view);
        return view;
    }

    private final class Cell extends LinearLayout {
        Cell() { super(activity); }
        @Override protected void onMeasure(int widthSpec, int heightSpec) {
            int height = MeasureSpec.getSize(heightSpec);
            if (getChildCount() > 0 && MeasureSpec.getMode(heightSpec) == MeasureSpec.EXACTLY && height > 0) {
                int reserved = 0;
                if (getChildCount() > 1 && getChildAt(1) instanceof TextView label) {
                    label.setMaxLines(1);
                    LinearLayout.LayoutParams labelParams = (LinearLayout.LayoutParams) label.getLayoutParams();
                    labelParams.topMargin = dp(3);
                    label.measure(MeasureSpec.makeMeasureSpec(MeasureSpec.getSize(widthSpec), MeasureSpec.AT_MOST),
                            MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED));
                    reserved = label.getMeasuredHeight() + labelParams.topMargin;
                }
                int available = Math.max(dp(20), height - getPaddingTop() - getPaddingBottom() - reserved);
                ViewGroup.LayoutParams p = getChildAt(0).getLayoutParams();
                p.width = p.height = Math.min(dp(preferences.iconSizeDp()), Math.min(available,
                        Math.max(dp(20), MeasureSpec.getSize(widthSpec) - getPaddingLeft() - getPaddingRight())));
            }
            super.onMeasure(widthSpec, heightSpec);
        }
        @Override public boolean performClick() { return super.performClick(); }
    }

    private LinearLayout column() {
        LinearLayout layout = new LinearLayout(activity);
        layout.setOrientation(LinearLayout.VERTICAL);
        return layout;
    }

    private LinearLayout row() {
        LinearLayout layout = new LinearLayout(activity);
        layout.setOrientation(LinearLayout.HORIZONTAL);
        layout.setGravity(Gravity.CENTER_VERTICAL);
        return layout;
    }

    private TextView text(String value, int size, int color) {
        TextView view = new TextView(activity);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        return view;
    }

    private GradientDrawable shape(int color, int radius, int stroke, int strokeColor) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(color);
        shape.setCornerRadius(dp(radius));
        if (stroke > 0) shape.setStroke(dp(stroke), strokeColor);
        return shape;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private String tr(String chinese, String english) {
        return UiText.isEnglish(activity) ? english : chinese;
    }

    private record Location(int kind, int slot, int child) { }
    private record Destination(int slot, boolean folder) { }
    private interface BeforeCommit { void run(); }
}
