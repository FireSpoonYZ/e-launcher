package com.example.launcherprobe;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;

/** Device-local terminal preferences, separate from pairing credentials. */
final class TerminalShortcutStore {
    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("remote_terminal_shortcuts", Context.MODE_PRIVATE);
    }
    static String read(Context context) { return prefs(context).getString("presets_v1", null); }
    static void write(Context context, String value) throws Exception {
        if (value != null && (value.length() > 1048576 || new JSONArray(value).length() > 40))
            throw new IllegalArgumentException("At most 40 bounded shortcuts");
        SharedPreferences.Editor edit = prefs(context).edit();
        if (value == null) edit.remove("presets_v1"); else edit.putString("presets_v1", value);
        // Resolve the JS save only after Android has committed the preference to disk.
        if (!edit.commit()) throw new IllegalStateException("Could not persist terminal shortcuts");
    }
}
