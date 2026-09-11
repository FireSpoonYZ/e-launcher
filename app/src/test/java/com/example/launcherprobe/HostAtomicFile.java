package com.example.launcherprobe;

import android.util.AtomicFile;
import android.util.Log;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;

/**
 * Android's rename replaces an existing file; Windows File.renameTo does not.
 * Keep AtomicFile's real write/sync/recovery code and adapt only that OS operation.
 */
@Implements(AtomicFile.class)
public class HostAtomicFile {
    @Implementation(minSdk = 30)
    protected static void rename(File source, File target) {
        if (target.isDirectory() && !target.delete()) Log.e("AtomicFile", "Failed to delete directory " + target);
        try {
            Files.move(source.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException exception) {
            Log.e("AtomicFile", "Failed to rename " + source + " to " + target, exception);
        }
    }
}
