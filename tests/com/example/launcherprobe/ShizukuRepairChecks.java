package com.example.launcherprobe;

public final class ShizukuRepairChecks {
    public static void main(String[] args) {
        String own = "com.example.launcherprobe/.GestureService";
        String other = "reader/.SpeakService";
        String expandedOwn = "com.example.launcherprobe/com.example.launcherprobe.GestureService";

        assert AccessibilityServices.add(other, own).equals(other + ":" + own);
        assert AccessibilityServices.add(other + ":" + expandedOwn, own).equals(other + ":" + own);
        assert AccessibilityServices.remove(other + ":" + own + ":switch/.Access", own)
                .equals(other + ":switch/.Access");
        assert AccessibilityServices.contains(other + ":" + expandedOwn, own);
        assert AccessibilityServices.preservesOthers(other + ":switch/.Access",
                other + ":switch/.Access:" + own, own);
        assert !AccessibilityServices.preservesOthers(other + ":switch/.Access", other + ":" + own, own);
        assert AccessibilityServices.add(AccessibilityServices.add(other, own), own)
                .equals(other + ":" + own);
        System.out.println("PASS: Shizuku accessibility-list checks");
    }
}
