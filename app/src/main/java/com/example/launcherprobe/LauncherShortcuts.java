package com.example.launcherprobe;

import android.content.ComponentName;
import android.content.Context;
import android.content.pm.LauncherApps;
import android.content.pm.ShortcutInfo;
import android.graphics.Rect;
import android.graphics.drawable.Drawable;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.os.UserHandle;
import android.os.UserManager;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Native launcher shortcut access and ownership-aware pin coordination. */
public final class LauncherShortcuts {
    private static final int VISIBLE = LauncherApps.ShortcutQuery.FLAG_MATCH_DYNAMIC
            | LauncherApps.ShortcutQuery.FLAG_MATCH_MANIFEST;
    private static final int RESOLVABLE = VISIBLE
            | LauncherApps.ShortcutQuery.FLAG_MATCH_PINNED;

    private final LauncherApps launcherApps;
    private final UserManager users;
    private final Handler main = new Handler(Looper.getMainLooper());
    private LauncherApps.Callback callback;

    public LauncherShortcuts(Context context) {
        launcherApps = context.getSystemService(LauncherApps.class);
        users = context.getSystemService(UserManager.class);
    }

    public boolean hasAccess() {
        return launcherApps.hasShortcutHostPermission();
    }

    public List<ShortcutInfo> query(ComponentName activity) {
        LauncherApps.ShortcutQuery query = new LauncherApps.ShortcutQuery()
                .setActivity(activity)
                .setQueryFlags(VISIBLE);
        return shortcuts(query, Process.myUserHandle());
    }

    public ShortcutInfo resolve(String packageName, String shortcutId, long userSerial) {
        UserHandle user = users.getUserForSerialNumber(userSerial);
        if (user == null) return null;
        LauncherApps.ShortcutQuery query = new LauncherApps.ShortcutQuery()
                .setPackage(packageName)
                .setShortcutIds(Collections.singletonList(shortcutId))
                .setQueryFlags(RESOLVABLE);
        List<ShortcutInfo> matches = shortcuts(query, user);
        return matches.isEmpty() ? null : matches.get(0);
    }

    public Drawable icon(ShortcutInfo shortcut, int density) {
        return launcherApps.getShortcutIconDrawable(shortcut, density);
    }

    public void start(ShortcutInfo shortcut, Rect bounds) {
        launcherApps.startShortcut(shortcut, bounds, null);
    }

    public void pin(ShortcutInfo shortcut) {
        UserHandle user = shortcut.getUserHandle();
        LauncherApps.ShortcutQuery query = new LauncherApps.ShortcutQuery()
                .setPackage(shortcut.getPackage())
                .setQueryFlags(LauncherApps.ShortcutQuery.FLAG_MATCH_PINNED);
        Set<String> ids = new LinkedHashSet<>();
        for (ShortcutInfo pinned : shortcuts(query, user)) ids.add(pinned.getId());
        ids.add(shortcut.getId());
        launcherApps.pinShortcuts(shortcut.getPackage(), new ArrayList<>(ids), user);
    }

    public void syncPins(List<Pin> desired) {
        Set<UserHandle> accessibleUsers = new LinkedHashSet<>(launcherApps.getProfiles());
        Map<UserHandle, Map<String, Set<String>>> desiredByUser = new LinkedHashMap<>();
        for (Pin pin : desired) {
            UserHandle user = users.getUserForSerialNumber(pin.userSerial());
            if (user == null) throw new IllegalArgumentException("Unknown user serial: " + pin.userSerial());
            accessibleUsers.add(user);
            desiredByUser.computeIfAbsent(user, ignored -> new LinkedHashMap<>())
                    .computeIfAbsent(pin.packageName(), ignored -> new LinkedHashSet<>())
                    .add(pin.shortcutId());
        }

        Map<UserHandle, Set<String>> pinnedPackages = new LinkedHashMap<>();
        LauncherApps.ShortcutQuery query = new LauncherApps.ShortcutQuery()
                .setQueryFlags(LauncherApps.ShortcutQuery.FLAG_MATCH_PINNED);
        for (UserHandle user : accessibleUsers) {
            Set<String> packages = new LinkedHashSet<>();
            for (ShortcutInfo pinned : shortcuts(query, user)) packages.add(pinned.getPackage());
            pinnedPackages.put(user, packages);
        }

        for (UserHandle user : accessibleUsers) {
            Map<String, Set<String>> wanted = desiredByUser.getOrDefault(user, Collections.emptyMap());
            Set<String> packages = pinnedPackages.get(user);
            packages.addAll(wanted.keySet());
            for (String packageName : packages) {
                Set<String> ids = wanted.getOrDefault(packageName, Collections.emptySet());
                launcherApps.pinShortcuts(packageName, new ArrayList<>(ids), user);
            }
        }
    }

    public void register(Runnable onChanged) {
        unregister();
        LauncherApps.Callback next = new LauncherApps.Callback() {
            @Override public void onPackageAdded(String packageName, UserHandle user) { onChanged.run(); }
            @Override public void onPackageChanged(String packageName, UserHandle user) { onChanged.run(); }
            @Override public void onPackageRemoved(String packageName, UserHandle user) { onChanged.run(); }
            @Override public void onPackagesAvailable(String[] packageNames, UserHandle user,
                    boolean replacing) { onChanged.run(); }
            @Override public void onPackagesUnavailable(String[] packageNames, UserHandle user,
                    boolean replacing) { onChanged.run(); }
            @Override public void onPackagesSuspended(String[] packageNames, UserHandle user) { onChanged.run(); }
            @Override public void onPackagesUnsuspended(String[] packageNames, UserHandle user) { onChanged.run(); }
            @Override public void onShortcutsChanged(String packageName, List<ShortcutInfo> shortcuts,
                    UserHandle user) { onChanged.run(); }
        };
        launcherApps.registerCallback(next, main);
        callback = next;
    }

    public void unregister() {
        if (callback == null) return;
        launcherApps.unregisterCallback(callback);
        callback = null;
    }

    public long userSerial(ShortcutInfo shortcut) {
        return users.getSerialNumberForUser(shortcut.getUserHandle());
    }

    private List<ShortcutInfo> shortcuts(LauncherApps.ShortcutQuery query, UserHandle user) {
        List<ShortcutInfo> result = launcherApps.getShortcuts(query, user);
        return result == null ? Collections.emptyList() : result;
    }

    public record Pin(String packageName, String shortcutId, long userSerial) { }
}
