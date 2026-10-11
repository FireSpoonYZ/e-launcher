package com.example.launcherprobe;

import android.app.Instrumentation;
import android.app.KeyguardManager;
import android.app.UiAutomation;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.hardware.display.DisplayManager;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.util.Base64;
import android.view.Display;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.UUID;

import org.json.JSONObject;

/** Opt-in device end-to-end check: real Shower Binder, Settings rendering and input while locked. */
final class ShowerLockscreenChecks {
    static String run(Instrumentation test) throws Exception {
        Context context = test.getTargetContext();
        File artifacts = ChatStoreChecks.artifacts(test);
        UiAutomation automation = test.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
        DisplayManager displays = context.getSystemService(DisplayManager.class);
        KeyguardManager keyguard = context.getSystemService(KeyguardManager.class);
        require(!keyguard.isKeyguardLocked(), "Start with the device unlocked");
        String timeout = shell(automation, "settings get system screen_off_timeout").trim();
        String stayOn = shell(automation, "settings get global stay_on_while_plugged_in").trim();
        String lockDisabled = shell(automation, "locksettings get-disabled").trim();
        ShowerToolBridge tools = new ShowerToolBridge(context);
        String conversation = UUID.randomUUID().toString();
        int displayId = -1;
        Bitmap before = null;
        Bitmap after = null;
        try {
            shell(automation, "settings put system screen_off_timeout 15000");
            shell(automation, "settings put global stay_on_while_plugged_in 0");
            shell(automation, "locksettings set-disabled false");
            shell(automation, "input -d 0 keyevent 224");
            shell(automation, "wm dismiss-keyguard");
            JSONObject created = tools.execute(conversation, new JSONObject().put("action", "create")
                    .put("width", 720).put("height", 1280).put("dpi", 240));
            displayId = created.getInt("displayId");
            require(displayId > 0, "Expected a non-default display");
            tools.execute(conversation, new JSONObject().put("action", "launch")
                    .put("packageName", "com.android.settings"));
            SystemClock.sleep(2500);
            dump(automation, artifacts, "unlocked");
            Bitmap baseline = screenshot(tools, conversation, displayId, artifacts, "unlocked");
            baseline.recycle();

            shell(automation, "input -d 0 keyevent 223");
            long deadline = SystemClock.uptimeMillis() + 8000;
            while ((!keyguard.isKeyguardLocked() || displays.getDisplay(0).getState() != Display.STATE_OFF)
                    && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(100);
            requireLocked(displays, keyguard);
            // Exceed the configured display timeout without input, screenshots or Shower lease heartbeats.
            SystemClock.sleep(30000);
            dump(automation, artifacts, "locked-idle");
            requireLocked(displays, keyguard);
            require(displays.getDisplay(displayId) != null
                    && displays.getDisplay(displayId).getState() == Display.STATE_ON,
                    "Virtual display slept while the main display was locked");
            before = screenshot(tools, conversation, displayId, artifacts, "locked-before-input");
            tools.execute(conversation, new JSONObject().put("action", "swipe")
                    .put("x1", 360).put("y1", 1050).put("x2", 360).put("y2", 350).put("durationMs", 500));
            SystemClock.sleep(1000);
            after = screenshot(tools, conversation, displayId, artifacts, "locked-after-input");
            require(changed(before, after) > .02, "Accepted input did not change the virtual Settings page");
            requireLocked(displays, keyguard);
            dump(automation, artifacts, "locked-after-input");

            tools.execute(conversation, new JSONObject().put("action", "release"));
            deadline = SystemClock.uptimeMillis() + 5000;
            while (displays.getDisplay(displayId) != null && SystemClock.uptimeMillis() < deadline) {
                SystemClock.sleep(100);
            }
            require(displays.getDisplay(displayId) == null, "Released virtual display still exists");
            requireLocked(displays, keyguard);
            dump(automation, artifacts, "released");
            return "PASS: display " + displayId + " stayed visible after 30 s locked idle; swipe changed "
                    + Math.round(changed(before, after) * 100) + "% of sampled content; main screen stayed locked/off; release removed display";
        } finally {
            if (before != null) before.recycle();
            if (after != null) after.recycle();
            tools.forgetConversation(conversation);
            restoreSetting(automation, "system", "screen_off_timeout", timeout);
            restoreSetting(automation, "global", "stay_on_while_plugged_in", stayOn);
            shell(automation, "locksettings set-disabled " + lockDisabled);
            shell(automation, "input -d 0 keyevent 224");
            shell(automation, "wm dismiss-keyguard");
        }
    }

    private static void requireLocked(DisplayManager displays, KeyguardManager keyguard) {
        require(keyguard.isKeyguardLocked(), "Main display keyguard was dismissed");
        require(displays.getDisplay(0).getState() == Display.STATE_OFF, "Main display was woken up");
    }

    private static Bitmap screenshot(ShowerToolBridge tools, String conversation, int displayId,
            File artifacts, String name) throws Exception {
        JSONObject shot = tools.execute(conversation, new JSONObject().put("action", "screenshot")
                .put("maxWidth", 360).put("maxHeight", 640));
        require(shot.getInt("displayId") == displayId, "Screenshot came from a different display");
        byte[] png = Base64.decode(shot.getString("data"), Base64.DEFAULT);
        Files.write(new File(artifacts, name + ".png").toPath(), png);
        Bitmap image = BitmapFactory.decodeByteArray(png, 0, png.length);
        require(image != null, "Screenshot was not a decodable image");
        int visible = 0;
        int sampled = 0;
        for (int y = image.getHeight() / 10; y < image.getHeight() * 9 / 10; y += 4) {
            for (int x = image.getWidth() / 10; x < image.getWidth() * 9 / 10; x += 4) {
                int pixel = image.getPixel(x, y);
                if ((pixel >> 16 & 255) > 24 || (pixel >> 8 & 255) > 24 || (pixel & 255) > 24) visible++;
                sampled++;
            }
        }
        if (visible < sampled / 20) {
            image.recycle();
            throw new AssertionError("Virtual display content was black: " + name);
        }
        return image;
    }

    private static double changed(Bitmap first, Bitmap second) {
        require(first.getWidth() == second.getWidth() && first.getHeight() == second.getHeight(),
                "Screenshot dimensions changed");
        int changed = 0;
        int sampled = 0;
        for (int y = first.getHeight() / 5; y < first.getHeight() * 4 / 5; y += 4) {
            for (int x = first.getWidth() / 10; x < first.getWidth() * 9 / 10; x += 4) {
                int a = first.getPixel(x, y), b = second.getPixel(x, y);
                if (Math.abs((a >> 16 & 255) - (b >> 16 & 255))
                        + Math.abs((a >> 8 & 255) - (b >> 8 & 255))
                        + Math.abs((a & 255) - (b & 255)) > 60) changed++;
                sampled++;
            }
        }
        return (double) changed / sampled;
    }

    private static void dump(UiAutomation automation, File artifacts, String stage) throws Exception {
        for (String service : new String[]{"display", "power", "window"}) {
            Files.write(new File(artifacts, stage + "-" + service + ".txt").toPath(),
                    shell(automation, "dumpsys " + service).getBytes(StandardCharsets.UTF_8));
        }
    }

    private static void restoreSetting(UiAutomation automation, String namespace, String key, String value)
            throws Exception {
        shell(automation, "settings " + ("null".equals(value) ? "delete " : "put ") + namespace + " "
                + key + ("null".equals(value) ? "" : " " + value));
    }

    private static String shell(UiAutomation automation, String command) throws Exception {
        ParcelFileDescriptor descriptor = automation.executeShellCommand(command);
        try (java.io.InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor)) {
            return new String(input.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
