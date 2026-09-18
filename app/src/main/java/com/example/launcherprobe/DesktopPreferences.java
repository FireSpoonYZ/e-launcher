package com.example.launcherprobe;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import org.json.JSONObject;
import org.json.JSONException;

/** Desktop-only preferences. Consumers reload on resume or ACTION_CHANGED. */
public final class DesktopPreferences {
    public static final String ACTION_CHANGED = "com.example.launcherprobe.ACTION_DESKTOP_SETTINGS_CHANGED";
    public static final String STORE = "launcher_desktop";
    private final Context context;
    private final SharedPreferences prefs;
    public DesktopPreferences(Context context) {
        this.context = context.getApplicationContext();
        prefs = context.getSharedPreferences(STORE, Context.MODE_PRIVATE);
    }
    public int columns() { return prefs.getInt("columns", 4); }
    public int rows() { return prefs.getInt("rows", 8); }
    public int iconSizeDp() { return prefs.getInt("iconSize", 52); }
    public int labelSizeSp() { return prefs.getInt("labelSize", 13); }
    public boolean layoutLocked() { return prefs.getBoolean("locked", false); }
    public boolean dockVisible() { return prefs.getBoolean("dockVisible", true); }
    public boolean searchFiles() { return prefs.getBoolean("searchFiles", true); }
    public boolean searchShortcuts() { return prefs.getBoolean("searchShortcuts", true); }
    public String folderSort() { return prefs.getString("folderSort", "manual"); }
    public String swipeUp() { return prefs.getString("swipeUp", "library"); }
    public String swipeDown() {
        String value = prefs.getString("swipeDown", "none");
        return "search".equals(value) ? "none" : value;
    }
    public String theme() { return prefs.getString("theme", "system"); }
    public String wallpaper() { return prefs.getString("wallpaper", "mint"); }
    public String iconPack() { return prefs.getString("iconPack", ""); }
    public long revision() { return prefs.getLong("revision", 0); }
    public JSONObject exportSettings() throws JSONException {
        return new JSONObject().put("columns", columns()).put("rows", rows())
                .put("iconSize", iconSizeDp()).put("labelSize", labelSizeSp()).put("locked", layoutLocked())
                .put("dockVisible", dockVisible()).put("searchFiles", searchFiles()).put("searchShortcuts", searchShortcuts())
                .put("folderSort", folderSort()).put("swipeUp", swipeUp()).put("swipeDown", swipeDown())
                .put("theme", theme()).put("wallpaper", wallpaper()).put("iconPack", iconPack());
    }
    public void set(String key, Object value) throws JSONException {
        JSONObject values = exportSettings();
        if (!values.has(key)) throw new JSONException("未知桌面设置: " + key);
        values.put(key, value);
        replace(values);
    }
    public static void validate(JSONObject values) throws JSONException {
        range(values, "columns", 3, 6); range(values, "rows", 5, 10);
        range(values, "iconSize", 36, 72); range(values, "labelSize", 10, 22);
        for (String key : new String[]{"locked", "dockVisible", "searchFiles", "searchShortcuts"})
            if (!(values.get(key) instanceof Boolean)) throw new JSONException("无效开关: " + key);
        choice(values, "folderSort", "manual", "name");
        choice(values, "swipeUp", "library", "search", "none");
        choice(values, "swipeDown", "search", "library", "none");
        choice(values, "theme", "system", "light", "dark");
        choice(values, "wallpaper", "mint", "system");
        Object pack = values.get("iconPack");
        if (!(pack instanceof String) || ((String) pack).length() > 255
                || !((String) pack).matches("[a-zA-Z0-9_.]*")) throw new JSONException("无效图标包");
    }
    private static void range(JSONObject values, String key, int min, int max) throws JSONException {
        Object number = values.get(key);
        if (!(number instanceof Integer) || (Integer) number < min || (Integer) number > max)
            throw new JSONException("设置超出范围: " + key);
    }
    private static void choice(JSONObject values, String key, String... allowed) throws JSONException {
        Object value = values.get(key);
        for (String option : allowed) if (option.equals(value)) return;
        throw new JSONException("无效设置: " + key);
    }
    public void replace(JSONObject values) throws JSONException {
        validate(values);
        SharedPreferences.Editor editor = prefs.edit();
        // Whitelist only desktop values; never export assistant configuration or credentials.
        java.util.Iterator<String> keys = exportSettings().keys();
        while (keys.hasNext()) {
            String key = keys.next(); Object value = values.get(key);
            if (value instanceof Boolean) editor.putBoolean(key, (Boolean) value);
            else if (value instanceof Integer) editor.putInt(key, (Integer) value);
            else editor.putString(key, (String) value);
        }
        if (!editor.putLong("revision", revision() + 1).commit()) throw new JSONException("无法保存桌面设置");
        notifyChanged();
    }
    public void notifyChanged() {
        context.sendBroadcast(new Intent(ACTION_CHANGED).setPackage(context.getPackageName()));
    }
}
