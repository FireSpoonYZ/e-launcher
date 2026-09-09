package com.example.launcherprobe;

import java.util.Locale;

final class AppSearch {
    private AppSearch() { }

    static boolean matches(String label, String packageName, String query) {
        String needle = query.trim().toLowerCase(Locale.ROOT);
        return needle.isEmpty()
                || label.toLowerCase(Locale.ROOT).contains(needle)
                || packageName.toLowerCase(Locale.ROOT).contains(needle);
    }
}
