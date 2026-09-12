package com.example.launcherprobe;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.text.Collator;
import java.util.ArrayList;
import java.util.List;

/** Shared native app catalog; Launcher and Web chat use the same PackageManager semantics. */
final class DeviceActions {
    private DeviceActions() { }

    static List<ResolveInfo> apps(Context context) {
        PackageManager manager = context.getPackageManager();
        List<ResolveInfo> result = new ArrayList<>(manager.queryIntentActivities(
                new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0));
        Collator collator = Collator.getInstance();
        result.sort((left, right) -> collator.compare(left.loadLabel(manager).toString(), right.loadLabel(manager).toString()));
        return result;
    }

    static JSONArray appJson(Context context) throws Exception {
        PackageManager manager = context.getPackageManager();
        JSONArray result = new JSONArray();
        for (ResolveInfo app : apps(context)) result.put(new JSONObject()
                .put("label", app.loadLabel(manager).toString()).put("packageName", app.activityInfo.packageName)
                .put("className", app.activityInfo.name).put("icon", icon(app.loadIcon(manager))));
        return result;
    }

    static void launch(Context context, String packageName, String className) {
        if (packageName == null || className == null || packageName.isEmpty() || className.isEmpty())
            throw new IllegalArgumentException("应用组件无效");
        context.startActivity(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
                .setComponent(new ComponentName(packageName, className)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    private static String icon(Drawable drawable) {
        int size = 96;
        Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap); drawable.setBounds(0, 0, size, size); drawable.draw(canvas);
        ByteArrayOutputStream output = new ByteArrayOutputStream(); bitmap.compress(Bitmap.CompressFormat.PNG, 90, output); bitmap.recycle();
        return "data:image/png;base64," + Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP);
    }
}
