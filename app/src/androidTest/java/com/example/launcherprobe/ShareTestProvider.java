package com.example.launcherprobe;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/** Fixed synthetic fixtures only; cannot expose arbitrary paths or user data. */
public final class ShareTestProvider extends ContentProvider {
    static final String AUTHORITY = "com.example.launcherprobe.test.share";
    static Uri uri(String name) { return Uri.parse("content://" + AUTHORITY + "/" + name); }
    private String name(Uri uri) {
        String name = uri.getLastPathSegment();
        if (!AUTHORITY.equals(uri.getAuthority()) || !("notes.txt".equals(name) || "pixel.png".equals(name)
                || "empty.txt".equals(name) || "large.txt".equals(name)))
            throw new IllegalArgumentException("Unknown share fixture");
        return name;
    }
    private byte[] bytes(String name) {
        if ("pixel.png".equals(name)) return android.util.Base64.decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", 0);
        return ("empty.txt".equals(name) ? "" : "shared fixture\n").getBytes(StandardCharsets.UTF_8);
    }
    @Override public boolean onCreate() { return true; }
    @Override public String getType(Uri uri) { return name(uri).endsWith(".png") ? "image/png" : "text/plain"; }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
        String name = name(uri);
        MatrixCursor cursor = new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
        cursor.addRow(new Object[]{name, "large.txt".equals(name) ? 25L * 1024 * 1024 + 1 : bytes(name).length});
        return cursor;
    }
    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new FileNotFoundException("Read only");
        String name = name(uri); File file = new File(getContext().getCacheDir(), "share-fixture-" + name);
        try (FileOutputStream output = new FileOutputStream(file)) { output.write(bytes(name)); }
        catch (java.io.IOException error) { throw new FileNotFoundException(error.getMessage()); }
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
    }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String where, String[] args) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String where, String[] args) { throw new UnsupportedOperationException(); }
}
