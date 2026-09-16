package com.example.launcherprobe;

import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ResolveInfo;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

/** Versioned workspace. Slots are row-major anchors; widget spans reserve surrounding cells. */
final class HomeLayout {
    static final int SLOT_COUNT = 32;
    static final int VERSION = 2;
    int columns = 4;
    int rows = 8;
    private final ArrayList<Item> dock = new ArrayList<>(Collections.nCopies(5, null));
    private final ArrayList<String> undo = new ArrayList<>();
    private String committed;
    int pageSize() { return columns * rows; }
    int pageCount() { return Math.max(1, (slots.size() + pageSize() - 1) / pageSize()); }
    int size() { return slots.size(); }
    List<Item> dock() { return Collections.unmodifiableList(dock); }
    void setDock(int index, Item item) {
        if (item != null && (item.isWidget() || item.isFolder())) throw new IllegalArgumentException("Dock 仅支持应用和快捷方式");
        dock.set(index, item);
    }
    void addPage() { slots.addAll(Collections.nCopies(pageSize(), null)); }
    int ownerAt(int slot) {
        int page = slot / pageSize(), x = slot % columns, y = slot % pageSize() / columns;
        for (int i = page * pageSize(); i < Math.min(size(), (page + 1) * pageSize()); i++) {
            Item item = get(i);
            if (item != null && x >= i % columns && x < i % columns + item.spanX
                    && y >= i % pageSize() / columns && y < i % pageSize() / columns + item.spanY) return i;
        }
        return -1;
    }
    boolean fits(int slot, int spanX, int spanY, int ignore) {
        if (slot < 0 || slot >= size() || spanX < 1 || spanY < 1
                || slot % columns + spanX > columns || slot % pageSize() / columns + spanY > rows) return false;
        for (int y = 0; y < spanY; y++) for (int x = 0; x < spanX; x++) {
            int owner = ownerAt(slot + y * columns + x);
            if (owner >= 0 && owner != ignore) return false;
        }
        return true;
    }
    int vacancy(int spanX, int spanY) {
        for (int i = 0; i < size(); i++) if (fits(i, spanX, spanY, -1)) return i;
        int first = size(); addPage(); return first;
    }
    boolean resize(int slot, int x, int y) {
        Item item = get(slot);
        if (item == null || !item.isWidget() || !fits(slot, x, y, slot)) return false;
        item.spanX = x; item.spanY = y; return true;
    }
    boolean undo() {
        if (undo.isEmpty()) return false;
        String previous = undo.remove(undo.size() - 1);
        try { restore(new JSONObject(previous)); }
        catch (JSONException e) { throw new IllegalStateException(e); }
        committed = previous;
        preferences.edit().putString(LAYOUT_KEY, previous).apply();
        return true;
    }
    static final String PREFERENCES = "launcher_home";
    static final String LAYOUT_KEY = "layout";

    static final class Item {
        static final String APP = "app";
        static final String SHORTCUT = "shortcut";
        static final String FOLDER = "folder";
        static final String APPWIDGET = "appwidget";
        static final String AI_WIDGET = "ai_widget";
        static final String CLOCK = "clock";
        static final String WIDGET_PICKER = "widget_picker";
        static final String ASSISTANT = "assistant";
        int spanX = 1;
        int spanY = 1;
        int appWidgetId = -1;
        String provider;
        boolean isWidget() { return APPWIDGET.equals(type) || AI_WIDGET.equals(type) || CLOCK.equals(type) || WIDGET_PICKER.equals(type); }
        static Item widget(String type, int spanX, int spanY, int id, String provider) {
            Item item = new Item(type, null, null, null, 0, null, null, null);
            item.spanX = spanX; item.spanY = spanY; item.appWidgetId = id; item.provider = provider;
            return item;
        }
        static Item assistant() { return new Item(ASSISTANT, null, null, null, 0, null, null, null); }

        final String type;
        final String packageName;
        final String className;
        final String shortcutId;
        final long userSerial;
        final String folderId;
        final String name;
        final List<Item> children;

        private Item(String type, String packageName, String className, String shortcutId,
                long userSerial, String folderId, String name, List<Item> children) {
            this.type = type;
            this.packageName = packageName;
            this.className = className;
            this.shortcutId = shortcutId;
            this.userSerial = userSerial;
            this.folderId = folderId;
            this.name = name;
            this.children = children == null ? Collections.emptyList()
                    : Collections.unmodifiableList(new ArrayList<>(children));
        }

        static Item app(String packageName, String className) {
            return new Item(APP, packageName, className, null, 0, null, null, null);
        }

        static Item shortcut(String packageName, String shortcutId, long userSerial) {
            return new Item(SHORTCUT, packageName, null, shortcutId, userSerial, null, null, null);
        }

        static Item folder(String name, List<Item> children) {
            return folder(UUID.randomUUID().toString(), name, children);
        }

        static Item folder(String id, String name, List<Item> children) {
            for (Item child : children) {
                if (child == null || (!APP.equals(child.type) && !SHORTCUT.equals(child.type))) {
                    throw new IllegalArgumentException("文件夹不能嵌套");
                }
            }
            return new Item(FOLDER, null, null, null, 0, id, name, children);
        }

        boolean isFolder() { return FOLDER.equals(type); }
        boolean isShortcut() { return SHORTCUT.equals(type); }

        @Override public boolean equals(Object other) {
            if (!(other instanceof Item item)) return false;
            return type.equals(item.type)
                    && Objects.equals(packageName, item.packageName)
                    && Objects.equals(className, item.className)
                    && Objects.equals(shortcutId, item.shortcutId)
                    && userSerial == item.userSerial
                    && Objects.equals(folderId, item.folderId)
                    && Objects.equals(name, item.name)
                    && children.equals(item.children)
                    && spanX == item.spanX && spanY == item.spanY
                    && appWidgetId == item.appWidgetId && Objects.equals(provider, item.provider);
        }

        @Override public int hashCode() {
            return Objects.hash(type, packageName, className, shortcutId, userSerial,
                    folderId, name, children, spanX, spanY, appWidgetId, provider);
        }
    }

    private final SharedPreferences preferences;
    private final ArrayList<Item> slots;

    private HomeLayout(SharedPreferences preferences, List<Item> slots) {
        this.preferences = preferences;
        this.slots = new ArrayList<>(slots);
    }

    static HomeLayout load(Context context, List<ResolveInfo> apps) {
        SharedPreferences preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
        if (!preferences.contains(LAYOUT_KEY)) {
            ArrayList<Item> initial = emptySlots();
            ArrayList<ResolveInfo> defaults = new ArrayList<>(apps);
            defaults.sort(java.util.Comparator.comparingInt(app -> defaultRank(app.loadLabel(context.getPackageManager()).toString())));
            for (int index = 0; index < Math.min(8, defaults.size()); index++) {
                ResolveInfo app = defaults.get(index);
                ComponentName component = new ComponentName(
                        app.activityInfo.packageName, app.activityInfo.name);
                initial.set(index + 12, Item.app(component.getPackageName(), component.getClassName()));
            }
            HomeLayout layout = new HomeLayout(preferences, initial);
            layout.addDefaults(context, false);
            layout.save();
            return layout;
        }
        try {
            JSONObject source = new JSONObject(preferences.getString(LAYOUT_KEY, ""));
            int version = source.getInt("version");
            if (version != 1 && version != VERSION) throw new JSONException("unsupported desktop layout version");
            HomeLayout layout = new HomeLayout(preferences, emptySlots());
            layout.restore(source);
            if (version == 1) {
                preferences.edit().putString("layout_v1", source.toString()).apply();
                layout.addDefaults(context, true);
                layout.save();
            } else layout.committed = source.toString();
            return layout;
        } catch (JSONException exception) {
            throw new IllegalStateException("无法读取桌面布局", exception);
        }
    }

    List<Item> slots() { return Collections.unmodifiableList(slots); }
    Item get(int index) { return slots.get(index); }
    boolean isFull() { return !slots.contains(null); }

    void set(int index, Item item) {
        slots.set(index, item);
    }

    void remove(int index) {
        slots.set(index, null);
    }

    /** Free-grid moves never shift neighboring icons; occupied targets require an explicit merge. */
    boolean move(int from, int to) {
        if (from == to || slots.get(from) == null) return false;
        Item moving = slots.get(from);
        if (!fits(to, moving.spanX, moving.spanY, from)) return false;
        slots.set(from, null);
        slots.set(to, moving);
        return true;
    }

    boolean merge(int from, int to, String folderName) {
        if (from == to) return false;
        Item moving = slots.get(from);
        Item target = slots.get(to);
        if (moving == null || target == null || moving.isFolder() || moving.isWidget()
                || Item.ASSISTANT.equals(moving.type) || target.isWidget() || Item.ASSISTANT.equals(target.type)) return false;
        if (target.isFolder()) {
            ArrayList<Item> children = new ArrayList<>(target.children);
            children.add(moving);
            slots.set(to, Item.folder(target.folderId, target.name, children));
        } else {
            slots.set(to, Item.folder(folderName, List.of(target, moving)));
        }
        slots.set(from, null);
        return true;
    }

    boolean renameFolder(int slot, String name) {
        Item folder = slots.get(slot);
        if (folder == null || !folder.isFolder() || name.trim().isEmpty()) return false;
        slots.set(slot, Item.folder(folder.folderId, name.trim(), folder.children));
        return true;
    }

    boolean addToFolder(int slot, Item item) {
        Item folder = slots.get(slot);
        if (folder == null || !folder.isFolder() || item == null || item.isFolder() || item.isWidget() || Item.ASSISTANT.equals(item.type)) return false;
        ArrayList<Item> children = new ArrayList<>(folder.children);
        children.add(item);
        slots.set(slot, Item.folder(folder.folderId, folder.name, children));
        return true;
    }

    int addAllToFolder(int slot, List<Item> items) {
        Item folder = slots.get(slot);
        if (folder == null || !folder.isFolder()) return 0;
        ArrayList<Item> children = new ArrayList<>(folder.children);
        int added = 0;
        for (Item item : items) if (item != null && (Item.APP.equals(item.type) || Item.SHORTCUT.equals(item.type))) {
            children.add(item);
            added++;
        }
        if (added > 0) slots.set(slot, Item.folder(folder.folderId, folder.name, children));
        return added;
    }

    boolean moveInFolder(int slot, int from, int to) {
        Item folder = slots.get(slot);
        if (folder == null || !folder.isFolder() || from == to
                || from < 0 || to < 0 || from >= folder.children.size()
                || to >= folder.children.size()) return false;
        ArrayList<Item> children = new ArrayList<>(folder.children);
        Item moving = children.remove(from);
        children.add(to, moving);
        slots.set(slot, Item.folder(folder.folderId, folder.name, children));
        return true;
    }

    boolean removeFromFolder(int slot, int index) {
        Item folder = slots.get(slot);
        if (folder == null || !folder.isFolder() || index < 0 || index >= folder.children.size()) {
            return false;
        }
        ArrayList<Item> children = new ArrayList<>(folder.children);
        children.remove(index);
        slots.set(slot, Item.folder(folder.folderId, folder.name, children));
        return true;
    }

    /** Leaves the folder unchanged when a non-folder target is occupied, including widget spans. */
    boolean moveFromFolder(int folderSlot, int childIndex, int targetSlot) {
        Item folder = slots.get(folderSlot);
        if (folderSlot == targetSlot || folder == null || !folder.isFolder() || childIndex < 0
                || childIndex >= folder.children.size()) return false;
        Item moving = folder.children.get(childIndex);
        Item target = slots.get(targetSlot);
        if (target != null && target.isFolder()) {
            ArrayList<Item> targetChildren = new ArrayList<>(target.children);
            targetChildren.add(moving);
            slots.set(targetSlot, Item.folder(target.folderId, target.name, targetChildren));
        } else if (!fits(targetSlot, moving.spanX, moving.spanY, -1)) {
            return false;
        } else {
            slots.set(targetSlot, moving);
        }
        ArrayList<Item> children = new ArrayList<>(folder.children);
        children.remove(childIndex);
        slots.set(folderSlot, Item.folder(folder.folderId, folder.name, children));
        return true;
    }

    boolean removePackage(String packageName) {
        boolean changed = false;
        for (int slot = 0; slot < slots.size(); slot++) {
            Item item = slots.get(slot);
            if (item == null) continue;
            if (item.isFolder()) {
                ArrayList<Item> remaining = new ArrayList<>();
                for (Item child : item.children) {
                    if (!packageName.equals(child.packageName)) remaining.add(child);
                }
                if (remaining.size() != item.children.size()) {
                    slots.set(slot, Item.folder(item.folderId, item.name, remaining));
                    changed = true;
                }
            } else if (packageName.equals(item.packageName)) {
                slots.set(slot, null);
                changed = true;
            }
        }
        for (int i = 0; i < dock.size(); i++) {
            Item item = dock.get(i);
            if (item != null && packageName.equals(item.packageName)) { dock.set(i, null); changed = true; }
        }
        return changed;
    }

    Set<String> packageNames() {
        LinkedHashSet<String> result = new LinkedHashSet<>();
        for (Item item : slots) {
            if (item == null) continue;
            if (item.isFolder()) {
                for (Item child : item.children) result.add(child.packageName);
            } else {
                result.add(item.packageName);
            }
        }
        for (Item item : dock) if (item != null && item.packageName != null) result.add(item.packageName);
        result.remove(null);
        return result;
    }

    List<Item> shortcutItems() {
        ArrayList<Item> result = new ArrayList<>();
        for (Item item : slots) {
            if (item == null) continue;
            if (item.isShortcut()) result.add(item);
            else if (item.isFolder()) for (Item child : item.children) {
                if (child.isShortcut()) result.add(child);
            }
        }
        for (Item item : dock) if (item != null && item.isShortcut()) result.add(item);
        return result;
    }

    void save() {
        JSONObject target = new JSONObject();
        JSONArray values = new JSONArray();
        try {
            target.put("version", VERSION);
            for (Item item : slots) values.put(item == null ? JSONObject.NULL : writeItem(item));
            target.put("slots", values).put("columns", columns).put("rows", rows);
            JSONArray dockValues = new JSONArray();
            for (Item item : dock) dockValues.put(item == null ? JSONObject.NULL : writeItem(item));
            target.put("dock", dockValues);
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
        String next = target.toString();
        if (committed != null && !committed.equals(next)) {
            undo.add(committed);
            if (undo.size() > 20) undo.remove(0);
        }
        committed = next;
        preferences.edit().putString(LAYOUT_KEY, next).apply();
    }

    /** Validates without changing raw. AppWidget IDs are device-local and never restored. */
    static JSONObject validateBackup(JSONObject raw) throws JSONException {
        if (raw == null) throw new JSONException("缺少桌面布局");
        int version = backupInt(raw, "version");
        if (version != 1 && version != VERSION) throw new JSONException("不支持的桌面版本");
        int columns = raw.has("columns") ? backupInt(raw, "columns") : 4;
        int rows = raw.has("rows") ? backupInt(raw, "rows") : 8;
        if (columns < 3 || columns > 8 || rows < 4 || rows > 12) throw new JSONException("无效的桌面网格");
        JSONArray source = raw.getJSONArray("slots");
        if (source.length() > 12000) throw new JSONException("桌面项目过多");
        int pageSize = columns * rows;
        int count = Math.max(pageSize, ((source.length() + pageSize - 1) / pageSize) * pageSize);
        boolean[] occupied = new boolean[count];
        JSONArray slots = new JSONArray();
        boolean hasAi = false;
        for (int i = 0; i < count; i++) {
            if (i >= source.length() || source.isNull(i)) { slots.put(JSONObject.NULL); continue; }
            Item item = backupItem(source.getJSONObject(i), true);
            if (Item.AI_WIDGET.equals(item.type)) {
                if (hasAi) throw new JSONException("AI 小组件不能重复"); hasAi = true;
            }
            if (item.spanX > columns || item.spanY > rows || i % columns + item.spanX > columns
                    || i % pageSize / columns + item.spanY > rows) throw new JSONException("小组件越过页面边界");
            for (int y = 0; y < item.spanY; y++) for (int x = 0; x < item.spanX; x++) {
                int cell = i + y * columns + x;
                if (occupied[cell]) throw new JSONException("桌面项目重叠");
                occupied[cell] = true;
            }
            slots.put(writeItem(item));
        }
        JSONArray sourceDock = raw.optJSONArray("dock"), dock = new JSONArray();
        if (sourceDock != null && sourceDock.length() != 5) throw new JSONException("Dock 必须包含五个位置");
        for (int i = 0; i < 5; i++) {
            if (sourceDock == null || sourceDock.isNull(i)) { dock.put(JSONObject.NULL); continue; }
            Item item = backupItem(sourceDock.getJSONObject(i), false);
            dock.put(writeItem(item));
        }
        return new JSONObject().put("version", VERSION).put("columns", columns).put("rows", rows)
                .put("slots", slots).put("dock", dock);
    }

    private static Item backupItem(JSONObject value, boolean desktop) throws JSONException {
        String type = value.getString("type");
        if (Item.APP.equals(type)) return Item.app(required(value, "package"), required(value, "class"));
        if (Item.SHORTCUT.equals(type)) {
            Object serial = value.get("user");
            if (!(serial instanceof Integer) && !(serial instanceof Long)) throw new JSONException("无效用户类型");
            long user = ((Number) serial).longValue();
            if (user < 0) throw new JSONException("无效用户");
            return Item.shortcut(required(value, "package"), required(value, "id"), user);
        }
        if (Item.ASSISTANT.equals(type)) return Item.assistant();
        if (!desktop) throw new JSONException("文件夹不能嵌套，Dock 不支持文件夹或小组件");
        if (Item.FOLDER.equals(type)) {
            JSONArray children = value.getJSONArray("children");
            if (children.length() > 1000) throw new JSONException("文件夹项目过多");
            ArrayList<Item> items = new ArrayList<>();
            for (int i = 0; i < children.length(); i++) {
                Item child = backupItem(children.getJSONObject(i), false);
                if (!Item.APP.equals(child.type) && !Item.SHORTCUT.equals(child.type)) throw new JSONException("无效文件夹项目");
                items.add(child);
            }
            return Item.folder(required(value, "folderId"), required(value, "name"), items);
        }
        if (Item.APPWIDGET.equals(type) || Item.AI_WIDGET.equals(type) || Item.CLOCK.equals(type) || Item.WIDGET_PICKER.equals(type)) {
            int x = backupInt(value, "spanX"), y = backupInt(value, "spanY");
            if (x < 1 || y < 1) throw new JSONException("无效小组件尺寸");
            String provider = null;
            if (Item.APPWIDGET.equals(type)) {
                provider = required(value, "provider");
                if (ComponentName.unflattenFromString(provider) == null) throw new JSONException("无效小组件提供方");
            }
            return Item.widget(type, x, y, -1, provider);
        }
        throw new JSONException("未知桌面项目类型");
    }
    private static int backupInt(JSONObject value, String key) throws JSONException {
        Object number = value.get(key);
        if (!(number instanceof Integer) && !(number instanceof Long)) throw new JSONException("无效整数：" + key);
        long result = ((Number) number).longValue();
        if (result < Integer.MIN_VALUE || result > Integer.MAX_VALUE) throw new JSONException("整数越界：" + key);
        return (int) result;
    }
    private static String required(JSONObject value, String key) throws JSONException {
        if (!(value.get(key) instanceof String)) throw new JSONException("无效文字字段：" + key);
        String text = value.getString(key);
        if (text.trim().isEmpty() || text.length() > 4096) throw new JSONException("无效字段：" + key);
        return text;
    }

    /** Commit first, then release superseded host resources. Failure never replaces the layout. */
    static void restoreBackup(Context context, JSONObject validated) throws JSONException {
        JSONObject clean = validateBackup(validated);
        SharedPreferences preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
        String old = preferences.getString(LAYOUT_KEY, null);
        ArrayList<Integer> ids = new ArrayList<>();
        if (old != null) {
            JSONObject previous = new JSONObject(old);
            JSONArray slots = previous.getJSONArray("slots");
            for (int i = 0; i < slots.length(); i++) {
                JSONObject item = slots.optJSONObject(i);
                if (item != null && Item.APPWIDGET.equals(item.optString("type")) && item.optInt("appWidgetId", -1) >= 0)
                    ids.add(item.getInt("appWidgetId"));
            }
        }
        SharedPreferences.Editor editor = preferences.edit().putString(LAYOUT_KEY, clean.toString());
        if (old != null) editor.putString("layout_before_restore", old);
        if (!editor.commit()) {
            SharedPreferences.Editor rollback = preferences.edit();
            if (old == null) rollback.remove(LAYOUT_KEY); else rollback.putString(LAYOUT_KEY, old);
            rollback.commit();
            throw new JSONException("无法保存桌面备份，已恢复原布局");
        }
        SharedPreferences pending = context.getSharedPreferences("desktop_widget_pending", Context.MODE_PRIVATE);
        int pendingId = pending.getInt("id", -1);
        if (pendingId >= 0) ids.add(pendingId);
        pending.edit().clear().commit();
        android.appwidget.AppWidgetHost host = new android.appwidget.AppWidgetHost(context, DesktopWidgets.HOST_ID);
        for (int id : ids) {
            try { host.deleteAppWidgetId(id); }
            catch (RuntimeException e) { android.util.Log.w("HomeLayout", "Could not release old widget " + id, e); }
        }
    }

    private void restore(JSONObject source) throws JSONException {
        columns = Math.max(3, Math.min(8, source.optInt("columns", 4)));
        rows = Math.max(4, Math.min(12, source.optInt("rows", 8)));
        JSONArray stored = source.getJSONArray("slots");
        if (stored.length() > 12000) throw new JSONException("desktop too large");
        slots.clear();
        slots.addAll(Collections.nCopies(Math.max(pageSize(), ((stored.length() + pageSize() - 1) / pageSize()) * pageSize()), null));
        for (int index = 0; index < stored.length(); index++) {
            if (stored.isNull(index)) continue;
            Item item = readItem(stored.getJSONObject(index), true);
            item.spanX = Math.min(columns, item.spanX);
            item.spanY = Math.min(rows, item.spanY);
            slots.set(fits(index, item.spanX, item.spanY, -1) ? index : vacancy(item.spanX, item.spanY), item);
        }
        JSONArray values = source.optJSONArray("dock");
        for (int i = 0; i < dock.size(); i++) {
            Item item = values == null || i >= values.length() || values.isNull(i) ? null : readItem(values.getJSONObject(i), false);
            dock.set(i, item);
        }
    }

    void configureGrid(int newColumns, int newRows) {
        newColumns = Math.max(3, Math.min(8, newColumns));
        newRows = Math.max(4, Math.min(12, newRows));
        if (columns == newColumns && rows == newRows) return;
        ArrayList<Item> items = new ArrayList<>(slots);
        columns = newColumns; rows = newRows;
        slots.clear(); addPage();
        for (Item item : items) if (item != null) {
            item.spanX = Math.min(columns, item.spanX); item.spanY = Math.min(rows, item.spanY);
            slots.set(vacancy(item.spanX, item.spanY), item);
        }
        save();
    }

    private static int defaultRank(String label) {
        String value = label.toLowerCase(java.util.Locale.ROOT);
        String[][] groups = {{"相册", "图库", "gallery", "photos"}, {"日历", "calendar"},
                {"时钟", "clock"}, {"天气", "weather"}, {"设置", "settings"},
                {"文件", "files", "file manager"}, {"笔记", "便签", "notes"}, {"微信", "wechat"}};
        for (int i = 0; i < groups.length; i++) for (String name : groups[i]) if (value.contains(name)) return i;
        return groups.length;
    }

    private void addDefaults(Context context, boolean migrated) {
        slots.set(migrated ? vacancy(4, 1) : 0, Item.widget(Item.CLOCK, 4, 1, -1, null));
        if (migrated) slots.set(vacancy(4, 2), Item.widget(Item.WIDGET_PICKER, 4, 2, -1, null));
        else {
            slots.set(4, Item.widget(Item.WIDGET_PICKER, 2, 2, -1, null));
            slots.set(6, Item.widget(Item.WIDGET_PICKER, 2, 2, -1, null));
        }
        slots.set(migrated ? vacancy(4, 3) : 20, Item.widget(Item.AI_WIDGET, 4, 3, -1, null));
        android.content.Intent[] intents = {
            new android.content.Intent(android.content.Intent.ACTION_DIAL),
            new android.content.Intent(android.content.Intent.ACTION_MAIN).addCategory(android.content.Intent.CATEGORY_APP_MESSAGING),
            new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse("https://example.com")),
            new android.content.Intent(android.provider.MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA)
        };
        for (int i = 0; i < intents.length; i++) {
            ResolveInfo resolved = context.getPackageManager().resolveActivity(intents[i], android.content.pm.PackageManager.MATCH_DEFAULT_ONLY);
            if (resolved != null && resolved.activityInfo != null) {
                android.content.Intent launch = context.getPackageManager().getLaunchIntentForPackage(resolved.activityInfo.packageName);
                if (launch != null && launch.getComponent() != null) dock.set(i,
                        Item.app(launch.getComponent().getPackageName(), launch.getComponent().getClassName()));
            }
        }
        dock.set(4, Item.assistant());
    }

    private static ArrayList<Item> emptySlots() {
        return new ArrayList<>(Collections.nCopies(SLOT_COUNT, null));
    }

    private static JSONObject writeItem(Item item) throws JSONException {
        JSONObject value = new JSONObject().put("type", item.type);
        if (item.isWidget()) return value.put("spanX", item.spanX).put("spanY", item.spanY)
                .put("appWidgetId", item.appWidgetId).put("provider", item.provider);
        if (Item.ASSISTANT.equals(item.type)) return value;
        if (Item.APP.equals(item.type)) {
            return value.put("package", item.packageName).put("class", item.className);
        }
        if (Item.SHORTCUT.equals(item.type)) {
            return value.put("package", item.packageName).put("id", item.shortcutId)
                    .put("user", item.userSerial);
        }
        JSONArray children = new JSONArray();
        for (Item child : item.children) children.put(writeItem(child));
        return value.put("folderId", item.folderId).put("name", item.name)
                .put("children", children);
    }

    private static Item readItem(JSONObject value, boolean allowFolder) throws JSONException {
        String type = value.getString("type");
        if (allowFolder && (Item.APPWIDGET.equals(type) || Item.AI_WIDGET.equals(type) || Item.CLOCK.equals(type) || Item.WIDGET_PICKER.equals(type)))
            return Item.widget(type, Math.max(1, value.optInt("spanX", 1)), Math.max(1, value.optInt("spanY", 1)),
                    value.optInt("appWidgetId", -1), value.optString("provider", null));
        if (Item.ASSISTANT.equals(type)) return Item.assistant();
        if (Item.APP.equals(type)) return Item.app(value.getString("package"), value.getString("class"));
        if (Item.SHORTCUT.equals(type)) {
            return Item.shortcut(value.getString("package"), value.getString("id"), value.getLong("user"));
        }
        if (!allowFolder || !Item.FOLDER.equals(type)) throw new JSONException("invalid desktop item");
        JSONArray values = value.getJSONArray("children");
        ArrayList<Item> children = new ArrayList<>();
        for (int index = 0; index < values.length(); index++) {
            children.add(readItem(values.getJSONObject(index), false));
        }
        return Item.folder(value.getString("folderId"), value.getString("name"), children);
    }
}
