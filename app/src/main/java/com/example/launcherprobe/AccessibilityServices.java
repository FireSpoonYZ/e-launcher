package com.example.launcherprobe;

import java.util.ArrayList;
import java.util.List;

/** Exact colon-list edits used to preserve every accessibility service except our own entry. */
final class AccessibilityServices {
    private AccessibilityServices() { }

    static String add(String current, String own) {
        List<String> entries = without(current, own);
        entries.add(own);
        return String.join(":", entries);
    }

    static String remove(String current, String own) {
        return String.join(":", without(current, own));
    }

    static boolean contains(String current, String own) {
        for (String entry : split(current)) if (sameComponent(entry, own)) return true;
        return false;
    }

    static boolean preservesOthers(String before, String after, String own) {
        List<String> remaining = new ArrayList<>(split(after));
        remaining.removeIf(entry -> sameComponent(entry, own));
        for (String entry : split(before)) {
            if (sameComponent(entry, own)) continue;
            int index = remaining.indexOf(entry);
            if (index < 0) return false;
            remaining.remove(index);
        }
        return true;
    }

    private static List<String> without(String current, String own) {
        List<String> result = new ArrayList<>();
        for (String entry : split(current)) if (!sameComponent(entry, own)) result.add(entry);
        return result;
    }

    private static List<String> split(String value) {
        List<String> entries = new ArrayList<>();
        if (value == null || value.isEmpty()) return entries;
        for (String entry : value.split(":")) if (!entry.isEmpty()) entries.add(entry);
        return entries;
    }

    private static boolean sameComponent(String left, String right) {
        int leftSlash = left.indexOf('/');
        int rightSlash = right.indexOf('/');
        if (leftSlash < 0 || rightSlash < 0) return left.equals(right);
        String leftPackage = left.substring(0, leftSlash);
        String rightPackage = right.substring(0, rightSlash);
        if (!leftPackage.equals(rightPackage)) return false;
        return expand(leftPackage, left.substring(leftSlash + 1))
                .equals(expand(rightPackage, right.substring(rightSlash + 1)));
    }

    private static String expand(String packageName, String className) {
        return className.startsWith(".") ? packageName + className : className;
    }
}
