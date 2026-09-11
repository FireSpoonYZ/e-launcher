package com.example.launcherprobe;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.ImageDecoder;
import android.net.Uri;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

final class BackgroundImage {
    private static final Object LOCK = new Object();
    private static long generation;

    static long beginImport() { synchronized (LOCK) { return ++generation; } }

    static void setMode(Context context, String mode) {
        synchronized (LOCK) {
            generation++;
            context.getSharedPreferences("ui", Context.MODE_PRIVATE).edit().putString("background", mode).apply();
        }
    }

    static void clear(Context context) throws IOException {
        synchronized (LOCK) {
            generation++;
            File image = new File(context.getFilesDir(), "appearance/background.png");
            new AtomicFile(image).delete();
            if (image.exists()) throw new IOException("无法清除图片");
            context.getSharedPreferences("ui", Context.MODE_PRIVATE).edit().putString("background", "solid")
                    .putLong("backgroundVersion", System.currentTimeMillis()).apply();
        }
    }

    static boolean importImage(Context context, Uri uri, long operation) throws IOException {
        Bitmap image = ImageDecoder.decodeBitmap(ImageDecoder.createSource(context.getContentResolver(), uri), (decoder, info, source) -> {
            int width = info.getSize().getWidth(), height = info.getSize().getHeight();
            int longest = Math.max(width, height);
            if (longest > 1600) decoder.setTargetSize(Math.max(1, (int) (width * 1600L / longest)), Math.max(1, (int) (height * 1600L / longest)));
            decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
        });
        try { return commit(context, image, operation); }
        finally { image.recycle(); }
    }

    static boolean commit(Context context, Bitmap image, long operation) throws IOException {
        synchronized (LOCK) {
            if (operation != generation) return false;
            File directory = new File(context.getFilesDir(), "appearance");
            if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法创建背景目录");
            AtomicFile file = new AtomicFile(new File(directory, "background.png"));
            FileOutputStream output = null;
            try {
                output = file.startWrite();
                if (!image.compress(Bitmap.CompressFormat.PNG, 100, output)) throw new IOException("无法保存背景图片");
                file.finishWrite(output);
            } catch (IOException exception) {
                if (output != null) file.failWrite(output);
                throw exception;
            }
            context.getSharedPreferences("ui", Context.MODE_PRIVATE).edit().putString("background", "image")
                    .putLong("backgroundVersion", System.currentTimeMillis()).apply();
            return true;
        }
    }
}
