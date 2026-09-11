package com.example.launcherprobe;

import android.content.Context;
import android.os.Binder;
import android.os.Process;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

/** Shizuku operations restricted to this app's permission and HOME role. */
public final class OwnPermissionService extends IOwnPermissionService.Stub {
    private final int appUid;
    private final String packageName;
    private final String userId;

    public OwnPermissionService(Context context) {
        appUid = context.getApplicationInfo().uid;
        packageName = context.getPackageName();
        // Android assigns application UIDs in per-user ranges of 100000.
        userId = Integer.toString(appUid / 100000);
    }

    @Override
    public String grantOwnWriteSecureSettings() {
        return run("/system/bin/pm", "grant", "--user", userId,
                packageName, "android.permission.WRITE_SECURE_SETTINGS");
    }

    @Override
    public String setOwnDefaultHome() {
        return run("/system/bin/cmd", "role", "add-role-holder", "--user", userId,
                "android.app.role.HOME", packageName, "0");
    }

    private String run(String... command) {
        if (Binder.getCallingUid() != appUid) throw new SecurityException("Caller is not this app");
        java.lang.Process child = null;
        try {
            child = new ProcessBuilder(command).redirectErrorStream(true).start();
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            java.lang.Process running = child;
            Thread drain = new Thread(() -> drain(running.getInputStream(), output), "shizuku-command-output");
            drain.start();
            if (!child.waitFor(10, TimeUnit.SECONDS)) {
                child.destroyForcibly();
                drain.join(1000);
                return "Command timed out";
            }
            drain.join(1000);
            String detail = new String(output.toByteArray(), StandardCharsets.UTF_8).trim();
            return child.exitValue() == 0 ? "" : "Command exit " + child.exitValue()
                    + (detail.isEmpty() ? "" : ": " + detail);
        } catch (Exception exception) {
            if (child != null) child.destroyForcibly();
            return exception.getClass().getSimpleName() + ": " + exception.getMessage();
        }
    }

    private static void drain(InputStream input, ByteArrayOutputStream output) {
        byte[] buffer = new byte[512];
        try {
            for (int count; (count = input.read(buffer)) != -1; ) {
                if (output.size() < 4096) output.write(buffer, 0, Math.min(count, 4096 - output.size()));
            }
        } catch (Exception ignored) { }
    }

    @Override
    public void destroy() {
        int caller = Binder.getCallingUid();
        if (caller != appUid && caller != 0 && caller != Process.SHELL_UID) {
            throw new SecurityException("Caller cannot destroy service");
        }
        System.exit(0);
    }
}
