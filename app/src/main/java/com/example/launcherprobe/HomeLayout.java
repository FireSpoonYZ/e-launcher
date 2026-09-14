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

/** The persisted eight-slot desktop. Folder children are deliberately limited to apps and shortcuts. */
final class HomeLayout {
    static final int SLOT_COUNT = 8;
    static final int VERSION = 1;
    static final String PREFERENCES = "launcher_home";
    static final String LAYOUT_KEY = "layout";

    static final class Item {
        static final String APP = "app";
        static final String SHORTCUT = "shortcut";
        static final String FOLDER = "folder";

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
                if (child == null || FOLDER.equals(child.type)) {
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
                    && children.equals(item.children);
        }

        @Override public int hashCode() {
            return Objects.hash(type, packageName, className, shortcutId, userSerial,
                    folderId, name, children);
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
            for (int index = 0; index < Math.min(SLOT_COUNT, apps.size()); index++) {
                ResolveInfo app = apps.get(index);
                ComponentName component = new ComponentName(
                        app.activityInfo.packageName, app.activityInfo.name);
                initial.set(index, Item.app(component.getPackageName(), component.getClassName()));
            }
            HomeLayout layout = new HomeLayout(preferences, initial);
            layout.save();
            return layout;
        }
        try {
            JSONObject source = new JSONObject(preferences.getString(LAYOUT_KEY, ""));
            if (source.getInt("version") != VERSION) {
                throw new JSONException("unsupported desktop layout version");
            }
            JSONArray stored = source.getJSONArray("slots");
            ArrayList<Item> slots = emptySlots();
            for (int index = 0; index < Math.min(SLOT_COUNT, stored.length()); index++) {
                if (!stored.isNull(index)) slots.set(index, readItem(stored.getJSONObject(index), true));
            }
            return new HomeLayout(preferences, slots);
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

    /** Empty targets are direct moves; occupied targets are stable insertion/reorders. */
    boolean move(int from, int to) {
        if (from == to || slots.get(from) == null) return false;
        Item moving = slots.get(from);
        if (slots.get(to) == null) {
            slots.set(from, null);
            slots.set(to, moving);
            return true;
        }
        if (from < to) {
            for (int index = from; index < to; index++) slots.set(index, slots.get(index + 1));
        } else {
            for (int index = from; index > to; index--) slots.set(index, slots.get(index - 1));
        }
        slots.set(to, moving);
        return true;
    }

    boolean merge(int from, int to, String folderName) {
        if (from == to) return false;
        Item moving = slots.get(from);
        Item target = slots.get(to);
        if (moving == null || target == null || moving.isFolder()) return false;
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
        if (folder == null || !folder.isFolder() || item == null || item.isFolder()) return false;
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
        for (Item item : items) if (item != null && !item.isFolder()) {
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

    /** Leaves the folder unchanged when a non-folder target is occupied. */
    boolean moveFromFolder(int folderSlot, int childIndex, int targetSlot) {
        Item folder = slots.get(folderSlot);
        if (folderSlot == targetSlot || folder == null || !folder.isFolder() || childIndex < 0
                || childIndex >= folder.children.size()) return false;
        Item target = slots.get(targetSlot);
        if (target != null && !target.isFolder()) return false;
        Item moving = folder.children.get(childIndex);
        if (target == null) {
            slots.set(targetSlot, moving);
        } else {
            ArrayList<Item> targetChildren = new ArrayList<>(target.children);
            targetChildren.add(moving);
            slots.set(targetSlot, Item.folder(target.folderId, target.name, targetChildren));
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
        return result;
    }

    void save() {
        JSONObject target = new JSONObject();
        JSONArray values = new JSONArray();
        try {
            target.put("version", VERSION);
            for (Item item : slots) values.put(item == null ? JSONObject.NULL : writeItem(item));
            target.put("slots", values);
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
        preferences.edit().putString(LAYOUT_KEY, target.toString()).apply();
    }

    private static ArrayList<Item> emptySlots() {
        return new ArrayList<>(Collections.nCopies(SLOT_COUNT, null));
    }

    private static JSONObject writeItem(Item item) throws JSONException {
        JSONObject value = new JSONObject().put("type", item.type);
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
