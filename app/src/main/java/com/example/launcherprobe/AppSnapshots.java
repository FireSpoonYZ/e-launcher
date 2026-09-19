package com.example.launcherprobe;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

/** Screens this launcher captured itself while the user left an app; never a system task snapshot. */
final class AppSnapshots {
    private static final int MAX_EDGE = 720;

    private AppSnapshots() { }

    static void save(Context context, String packageName, Bitmap screen) {
        float scale = Math.min(1f, MAX_EDGE / (float) Math.max(screen.getWidth(), screen.getHeight()));
        Bitmap scaled = scale == 1f ? screen : Bitmap.createScaledBitmap(screen,
                Math.max(1, Math.round(screen.getWidth() * scale)),
                Math.max(1, Math.round(screen.getHeight() * scale)), true);
        File file = file(context, packageName);
        try (FileOutputStream output = new FileOutputStream(file)) {
            scaled.compress(Bitmap.CompressFormat.JPEG, 80, output);
        } catch (IOException | RuntimeException failure) {
            file.delete();
        } finally {
            if (scaled != screen) scaled.recycle();
        }
    }

    /** Decoded at roughly card width; a full-resolution screen per app would cost tens of megabytes. */
    static Bitmap load(Context context, String packageName, int targetWidth) {
        File file = file(context, packageName);
        if (!file.isFile()) return null;
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getPath(), bounds);
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inPreferredConfig = Bitmap.Config.RGB_565;
        options.inSampleSize = 1; // A fresh Options starts at 0, which is not a usable divisor.
        while (targetWidth > 0 && bounds.outWidth / (options.inSampleSize * 2) >= targetWidth)
            options.inSampleSize *= 2;
        return BitmapFactory.decodeFile(file.getPath(), options);
    }

    static void forget(Context context, String packageName) {
        file(context, packageName).delete();
    }

    static void clear(Context context) {
        File[] files = directory(context).listFiles();
        if (files != null) for (File file : files) file.delete();
    }

    private static File file(Context context, String packageName) {
        return new File(directory(context), packageName.replaceAll("[^A-Za-z0-9._-]", "_") + ".jpg");
    }

    private static File directory(Context context) {
        File directory = new File(context.getFilesDir(), "app_snapshots");
        if (!directory.isDirectory()) directory.mkdirs();
        return directory;
    }
}
