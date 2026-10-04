package com.example.launcherprobe;

import android.content.Context;
import android.content.pm.PackageManager;
import com.getcapacitor.JSObject;
import java.io.File;
import java.io.InputStream;
import rikka.shizuku.Shizuku;

/** Passive observations only: never starts Node, a Shizuku service, or a display. */
final class CapabilityReadiness {
    private CapabilityReadiness() { }

    static JSObject device(Context context) throws Exception {
        boolean installed;
        try {
            context.getPackageManager().getPackageInfo("moe.shizuku.privileged.api", 0);
            installed = true;
        } catch (PackageManager.NameNotFoundException missing) { installed = false; }
        boolean running = false;
        String permission = "unknown";
        try {
            running = Shizuku.pingBinder();
            if (running) permission = Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED
                    ? "granted" : Shizuku.shouldShowRequestPermissionRationale() ? "denied" : "notGranted";
        } catch (RuntimeException unavailable) { permission = "unknown"; }
        String nativeDir = context.getApplicationInfo().nativeLibraryDir;
        boolean runtime = runtimeLibrariesPresent(nativeDir)
                && asset(context, "pi-runtime.cjs")
                && context.getAssets().list("pi-sdk").length > 0;
        String active = context.getSharedPreferences("chat", Context.MODE_PRIVATE).getString("active_chat", "legacy");
        ShowerController desktop = PiAgentBridge.existingDesktop(active);
        // hasDisplay neither creates nor extends the idle lifetime. Call this off the UI thread.
        boolean display = desktop != null && desktop.hasDisplay();
        return new JSObject().put("piInstalled", runtime).put("showerInstalled", asset(context, "shower-server.jar"))
                .put("shizukuInstalled", installed).put("shizukuRunning", running)
                .put("shizukuPermission", permission).put("showerDisplayActive", display);
    }

    static boolean runtimeLibrariesPresent(String nativeDir) {
        return nativeDir != null && new File(nativeDir, "libnode.so").isFile()
                && new File(nativeDir, "liblauncher_node.so").isFile()
                && new File(nativeDir, "libnode_launcher.so").isFile();
    }

    private static boolean asset(Context context, String name) {
        try (InputStream input = context.getAssets().open(name)) { return input.read() >= 0; }
        catch (Exception missing) { return false; }
    }
}
