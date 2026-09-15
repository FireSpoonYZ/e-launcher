package com.example.launcherprobe;

import net.sourceforge.pinyin4j.PinyinHelper;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Precomputed name keys; alternate character readings are matched without combinatorial expansion. */
final class SearchName {
    private final String label;
    private final List<String[]> syllables = new ArrayList<>();
    final String sortKey;

    SearchName(String value) {
        label = normalize(value);
        StringBuilder sort = new StringBuilder();
        for (int i = 0; i < label.length(); i++) {
            char ch = label.charAt(i);
            String[] readings = PinyinHelper.toHanyuPinyinStringArray(ch);
            if (readings == null) readings = new String[]{String.valueOf(ch)};
            else {
                readings = readings.clone();
                for (int j = 0; j < readings.length; j++)
                    readings[j] = readings[j].replaceAll("[1-5]$", "").replace("u:", "v");
            }
            syllables.add(readings);
            sort.append(readings[0]);
        }
        sortKey = sort.toString();
    }

    boolean matches(String query) {
        String needle = normalize(query);
        if (needle.isEmpty() || label.contains(needle) || sortKey.contains(needle)) return true;
        return matchesReadings(needle, false) || matchesReadings(needle, true);
    }

    private boolean matchesReadings(String needle, boolean initials) {
        // Track query offsets, not pronunciation permutations, including polyphonic app names.
        boolean[] offsets = new boolean[needle.length() + 1];
        for (String[] readings : syllables) {
            offsets[0] = true;
            boolean[] next = new boolean[offsets.length];
            for (int offset = 0; offset < needle.length(); offset++) {
                if (!offsets[offset]) continue;
                for (String reading : readings) {
                    String token = initials ? reading.substring(0, 1) : reading;
                    int remaining = needle.length() - offset;
                    if (token.startsWith(needle.substring(offset))) return true;
                    if (remaining >= token.length() && needle.startsWith(token, offset))
                        next[offset + token.length()] = true;
                }
            }
            if (next[needle.length()]) return true;
            offsets = next;
        }
        return false;
    }

    static String normalize(String value) {
        return Normalizer.normalize(value == null ? "" : value, Normalizer.Form.NFKC)
                .trim().toLowerCase(Locale.ROOT).replaceAll("[\\s·_-]+", "");
    }

    String section() {
        if (sortKey.isEmpty()) return "#";
        char first = Character.toUpperCase(sortKey.charAt(0));
        return first >= 'A' && first <= 'Z' ? String.valueOf(first) : "#";
    }
}
