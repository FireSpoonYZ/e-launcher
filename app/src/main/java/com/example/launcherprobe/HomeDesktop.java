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
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
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
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final int touchSlop;
    private final GridLayout grid;
    private List<ResolveInfo> apps;

    private DesktopMenu menu;
    private View dropTarget;
    private Dialog appDialog;
    private FrameLayout folderRoot;
    private FrameLayout folderPanel;
    private GridLayout folderGrid;
    private Bitmap folderBackdrop;
    private androidx.activity.OnBackPressedCallback folderBack;
    private View dragPreview;
    private int activeFolderSlot = -1;
    private boolean disposed;

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
        colors = AppAppearance.read(activity);
        touchSlop = ViewConfiguration.get(activity).getScaledTouchSlop();
        setClipChildren(false);
        setClipToPadding(false);
        grid = new GridLayout(activity);
        grid.setColumnCount(4);
        grid.setRowCount(2);
        addView(grid, new FrameLayout.LayoutParams(-1, dp(232)));
        render();
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
        dismissMenu();
        if (appDialog != null) appDialog.dismiss();
        closeFolder();
        clearDragPreview();
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
        dismissMenu();
        clearDropTarget();
        grid.removeAllViews();
        for (int slot = 0; slot < HomeLayout.SLOT_COUNT; slot++) {
            final int selectedSlot = slot;
            HomeLayout.Item item = layout.get(slot);
            Cell cell = cell(item);
            if (item != null) {
                cell.setContentDescription(itemDescription(item));
                cell.setOnClickListener(view -> activate(item, view, selectedSlot));
                cell.setOnTouchListener(new HomeTouch(selectedSlot, item, cell));
                cell.setOnLongClickListener(view -> {
                    showMenu(homeOverlay, view, item, new Location(HOME, selectedSlot, -1));
                    return true;
                });
            }
            GridLayout.LayoutParams params = new GridLayout.LayoutParams(
                    GridLayout.spec(slot / 4), GridLayout.spec(slot % 4, 1f));
            params.width = 0;
            params.height = dp(116);
            grid.addView(cell, params);
        }
    }

    private Cell cell(HomeLayout.Item item) {
        Cell cell = new Cell();
        cell.setOrientation(LinearLayout.VERTICAL);
        cell.setGravity(Gravity.TOP | Gravity.CENTER_HORIZONTAL);
        cell.setClickable(item != null);
        cell.setFocusable(item != null);
        cell.setPadding(dp(3), dp(10), dp(3), dp(6));
        cell.setBackgroundColor(Color.TRANSPARENT);
        if (item == null) return cell;
        cell.addView(itemIcon(item, 52), new LinearLayout.LayoutParams(dp(52), dp(52)));
        TextView name = text(itemLabel(item), 13,
                itemAvailable(item) ? colors.ink : colors.muted);
        name.setGravity(Gravity.CENTER);
        name.setMaxLines(2);
        name.setEllipsize(android.text.TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams nameParams = new LinearLayout.LayoutParams(-1, -2);
        nameParams.topMargin = dp(7);
        cell.addView(name, nameParams);
        return cell;
    }

    private View itemIcon(HomeLayout.Item item, int sizeDp) {
        int size = dp(sizeDp);
        if (item.isFolder()) return folderIcon(item, size);
        FrameLayout frame = new FrameLayout(activity);
        Drawable icon = item.isShortcut() ? shortcutIcon(item) : appIcon(item.packageName, item.className);
        ImageView image = new ImageView(activity);
        image.setImageDrawable(icon);
        image.setAlpha(icon == null ? .35f : 1f);
        if (icon == null) image.setBackground(shape(colors.panel, 13, 1, colors.border));
        frame.addView(image, new FrameLayout.LayoutParams(size, size));
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
        FrameLayout frame = new FrameLayout(activity);
        frame.setBackground(shape(colors.panel, 14, 1, colors.border));
        int miniature = Math.round(size * .34f);
        int margin = Math.round(size * .12f);
        for (int index = 0; index < Math.min(4, folder.children.size()); index++) {
            HomeLayout.Item child = folder.children.get(index);
            Drawable drawable = child.isShortcut() ? shortcutIcon(child)
                    : appIcon(child.packageName, child.className);
            ImageView icon = new ImageView(activity);
            icon.setImageDrawable(drawable);
            FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(miniature, miniature);
            params.leftMargin = margin + (index % 2) * (miniature + dp(3));
            params.topMargin = margin + (index / 2) * (miniature + dp(3));
            frame.addView(icon, params);
        }
        if (folder.children.isEmpty()) {
            TextView empty = text("□", 26, colors.muted);
            empty.setGravity(Gravity.CENTER);
            frame.addView(empty, new FrameLayout.LayoutParams(-1, -1));
        }
        return frame;
    }

    private final class HomeTouch implements View.OnTouchListener {
        final int slot;
        final HomeLayout.Item item;
        final View view;
        final Runnable longPress;
        float downX;
        float downY;
        boolean longPressed;
        boolean dragging;
        boolean moved;
        int hoverSlot = -1;
        long hoverSince;

        HomeTouch(int slot, HomeLayout.Item item, View view) {
            this.slot = slot;
            this.item = item;
            this.view = view;
            longPress = () -> {
                if (disposed) return;
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
                        startDragPreview(item);
                    }
                    if (dragging) updateHomeDrag(event);
                    return true;
                case MotionEvent.ACTION_UP:
                    handler.removeCallbacks(longPress);
                    if (dragging) finishHomeDrag(event);
                    else if (!longPressed && !moved) {
                        if (folderRoot != null) closeFolder();
                        else view.performClick();
                    }
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
            hoverSlot = -1;
            view.setAlpha(1f);
            if (view.getParent() != null) view.getParent().requestDisallowInterceptTouchEvent(false);
            clearDragPreview();
            clearDropTarget();
            restoreFolderSurface();
        }

        private float distance(MotionEvent event) {
            return (float) Math.hypot(event.getRawX() - downX, event.getRawY() - downY);
        }

        private void updateHomeDrag(MotionEvent event) {
            moveDragPreview(event.getRawX(), event.getRawY());
            if (folderPanel != null && contains(folderPanel, event.getRawX(), event.getRawY())) {
                hoverSlot = -1;
                clearDropTarget();
                restoreFolderSurface();
                return;
            }
            int target = homeTarget(event.getRawX(), event.getRawY());
            boolean centered = !item.isFolder() && target >= 0 && target != slot
                    && layout.get(target) != null
                    && centerHit(grid.getChildAt(target), event.getRawX(), event.getRawY());
            if (!centered || target != hoverSlot) {
                hoverSlot = centered ? target : -1;
                hoverSince = centered ? android.os.SystemClock.uptimeMillis() : 0;
                if (centered) handler.postDelayed(() -> {
                    if (!dragging || hoverSlot != target) return;
                    highlightDrop(target, true);
                    if (folderRoot == null && layout.get(target).isFolder()) openFolder(target);
                }, MERGE_HOVER_MS);
            }
            highlightDrop(target, centered && hoverSlot == target
                    && android.os.SystemClock.uptimeMillis() - hoverSince >= MERGE_HOVER_MS);
        }

        private void finishHomeDrag(MotionEvent event) {
            if (folderPanel != null && contains(folderPanel, event.getRawX(), event.getRawY())) {
                if (layout.merge(slot, activeFolderSlot, tr("文件夹", "Folder"))) {
                    persist();
                    renderFolder();
                }
                return;
            }
            int target = homeTarget(event.getRawX(), event.getRawY());
            if (target < 0 || target == slot) return;
            boolean merge = target == hoverSlot
                    && android.os.SystemClock.uptimeMillis() - hoverSince >= MERGE_HOVER_MS;
            closeFolder();
            boolean changed = merge
                    ? layout.merge(slot, target, tr("文件夹", "Folder"))
                    : layout.move(slot, target);
            if (changed) persist();
        }
    }

    private void activate(HomeLayout.Item item, View source, int slot) {
        if (item == null) {
            showAppPicker(slot, -1);
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
        closeFolder();
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
                    source = target >= 0 && layout.get(target) != null ? grid.getChildAt(target) : null;
                }
                if (Math.hypot(event.getRawX() - downX, event.getRawY() - downY) > touchSlop) moved = true;
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
        renderFolder();
        folderPanel.setScaleX(.96f);
        folderPanel.setScaleY(.96f);
        folderPanel.setAlpha(0f);
        folderPanel.animate().scaleX(1f).scaleY(1f).alpha(1f).setDuration(180).start();
        if (dragPreview != null) dragPreview.bringToFront();
    }

    private void closeFolder() {
        if (folderRoot == null) return;
        dismissMenu();
        ((ViewGroup) folderRoot.getParent()).removeView(folderRoot);
        folderBack.remove();
        folderBack = null;
        folderRoot = null;
        folderPanel = null;
        folderGrid = null;
        folderBackdrop = null;
        activeFolderSlot = -1;
    }

    private void renderFolder() {
        if (folderRoot == null || activeFolderSlot < 0) return;
        HomeLayout.Item folder = layout.get(activeFolderSlot);
        if (folder == null || !folder.isFolder()) {
            closeFolder();
            return;
        }
        dismissMenu();
        folderRoot.removeAllViews();
        folderRoot.setBackgroundColor(0x18000000);
        androidx.core.view.ViewCompat.setAccessibilityPaneTitle(folderRoot, folder.name);
        folderPanel = new FrameLayout(activity);
        int tint = colors.dark ? 0xb3252d28 : 0x99f8faf6;
        int edge = colors.dark ? 0x44768479 : 0x99ffffff;
        folderPanel.setBackground(shape(tint, 28, 1, edge));
        folderPanel.setClipToOutline(true);
        folderPanel.setElevation(dp(12));
        folderPanel.setClickable(true);
        View glass = new View(activity) {
            final Paint paint = new Paint(Paint.FILTER_BITMAP_FLAG);
            @Override protected void onDraw(Canvas canvas) {
                if (folderBackdrop == null) return;
                View host = activity.findViewById(android.R.id.content);
                int[] origin = new int[2];
                int[] position = new int[2];
                host.getLocationOnScreen(origin);
                getLocationOnScreen(position);
                int left = origin[0] - position[0];
                int top = origin[1] - position[1];
                canvas.drawBitmap(folderBackdrop, null,
                        new Rect(left, top, left + host.getWidth(), top + host.getHeight()), paint);
            }
        };
        if (Build.VERSION.SDK_INT >= 31) {
            glass.setRenderEffect(RenderEffect.createBlurEffect(dp(18), dp(18), Shader.TileMode.CLAMP));
        }
        glass.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        folderPanel.addView(glass, new FrameLayout.LayoutParams(-1, -1));
        View frost = new View(activity);
        frost.setBackground(shape(tint, 28, 1, edge));
        frost.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        folderPanel.addView(frost, new FrameLayout.LayoutParams(-1, -1));
        LinearLayout content = column();
        content.setPadding(dp(18), dp(8), dp(18), dp(16));
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
        content.addView(title, new LinearLayout.LayoutParams(-1, dp(60)));

        folderGrid = new GridLayout(activity);
        folderGrid.setColumnCount(3);
        int rows = Math.max(2, (folder.children.size() + 2) / 3);
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
        if (folder.children.isEmpty()) {
            TextView empty = text(tr("拖动应用到这里", "Drag apps here"), 15, colors.muted);
            empty.setGravity(Gravity.CENTER);
            content.addView(empty, new LinearLayout.LayoutParams(-1, 0, 1));
        } else content.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        folderPanel.addView(content, new FrameLayout.LayoutParams(-1, -1));
        Rect safe = new Rect();
        folderRoot.getWindowVisibleDisplayFrame(safe);
        FrameLayout.LayoutParams panelParams = new FrameLayout.LayoutParams(
                Math.min(dp(400), safe.width() - dp(48)),
                Math.min(dp(84 + Math.min(3, rows) * 112), safe.height() - dp(48)), Gravity.CENTER);
        folderRoot.addView(folderPanel, panelParams);
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
        folderRoot.setBackgroundColor(0x18000000);
        folderPanel.setAlpha(1f);
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
                if (folderRoot == null) return;
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
                        folderRoot.setBackgroundColor(outsideFolder ? Color.TRANSPARENT : 0x18000000);
                        folderPanel.setAlpha(outsideFolder ? 0f : 1f);
                        if (!outsideFolder) clearDropTarget();
                        else highlightDrop(homeTarget(event.getRawX(), event.getRawY()), false);
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
                    grid.getChildAt(targetSlot), event.getRawX(), event.getRawY())) return;
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
                nameParams.topMargin = dp(7);
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
        dismissMenu();
        ArrayList<Destination> destinations = new ArrayList<>();
        ArrayList<String> labels = new ArrayList<>();
        for (int slot = 0; slot < HomeLayout.SLOT_COUNT; slot++) {
            HomeLayout.Item existing = layout.get(slot);
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
        for (int slot = 0; slot < HomeLayout.SLOT_COUNT; slot++) {
            if (slot == folderSlot) continue;
            HomeLayout.Item existing = layout.get(slot);
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
        layout.save();
        syncPins();
        render();
    }

    private int homeTarget(float rawX, float rawY) {
        for (int index = 0; index < grid.getChildCount(); index++) {
            if (contains(grid.getChildAt(index), rawX, rawY)) return index;
        }
        return -1;
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
        int[] position = new int[2];
        view.getLocationOnScreen(position);
        float centerX = position[0] + view.getWidth() / 2f;
        float centerY = position[1] + view.getHeight() / 2f;
        return Math.abs(rawX - centerX) <= view.getWidth() * .28f
                && Math.abs(rawY - centerY) <= view.getHeight() * .28f;
    }

    private void highlightDrop(int slot, boolean merge) {
        View target = slot < 0 ? null : grid.getChildAt(slot);
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
            dismissMenu();
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
        if (app != null) return app.loadIcon(packages);
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
        if (item.isFolder()) return true;
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
        return view;
    }

    private final class Cell extends LinearLayout {
        Cell() { super(activity); }
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
