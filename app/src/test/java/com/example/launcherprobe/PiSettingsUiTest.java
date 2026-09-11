package com.example.launcherprobe;

import android.content.Context;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, shadows = HostAtomicFile.class)
public class PiSettingsUiTest {
    @Test public void changingLanguageAndThemePreservesInvalidDraftAndSavedValues() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("ui", 0).edit().clear().putString("language", "en").putString("theme", "light").commit();
        context.getSharedPreferences("PiSettingsActivity", 0).edit().clear().commit();
        PiConfigStore store = new PiConfigStore(context);
        store.initialize(context.getSharedPreferences("chat", 0));
        Files.createDirectories(store.directory(false).toPath());
        String saved = "{\"customText\":\"保存\",\"customNumber\":1e+02}\n";
        Files.write(store.directory(false).toPath().resolve("settings.json"), saved.getBytes(StandardCharsets.UTF_8));
        Bundle state = new Bundle(); state.putString("page", "file:settings.json");
        ActivityController<PiSettingsActivity> controller = Robolectric.buildActivity(PiSettingsActivity.class).create(state).start().resume().visible();
        try {
            View root = controller.get().getWindow().getDecorView();
            assertTrue(hasButton(root, "Save"));
            EditText editor = findEditor(root); assertNotNull(editor);
            assertEquals("保存", ConfigJson.object(editor.getText().toString()).get("customText"));
            String draft = "{\"customText\":\"保存，不要翻译\",\"customNumber\":1e+02";
            editor.setText(draft);
            context.getSharedPreferences("ui", 0).edit().putString("language", "zh").putString("theme", "dark").commit();
            controller.recreate();
            root = controller.get().getWindow().getDecorView();
            assertTrue(hasButton(root, "保存"));
            assertEquals(draft, findEditor(root).getText().toString());
            assertEquals(saved, store.read(false, "settings.json"));
            assertEquals(0, root.getSystemUiVisibility() & View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        } finally { controller.pause().stop().destroy(); }
    }

    @Test public void appearanceMaskChangesRevisionAndClearRemovesImportedImage() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        android.content.SharedPreferences ui = context.getSharedPreferences("ui", 0);
        ui.edit().clear().putString("language", "en").putString("background", "image").putInt("backgroundMask", 20).commit();
        String revision = AppAppearance.revision(context);
        ui.edit().putInt("backgroundMask", 100).commit();
        assertNotEquals(revision, AppAppearance.revision(context));
        assertEquals(255, android.graphics.Color.alpha(AppAppearance.read(context).maskColor(context)));
        ui.edit().putInt("backgroundMask", -5).commit();
        assertEquals(20, AppAppearance.maskStrength(context));
        java.io.File image = new java.io.File(context.getFilesDir(), "appearance/background.png");
        image.getParentFile().mkdirs();
        android.graphics.Bitmap bitmap = android.graphics.Bitmap.createBitmap(2, 2, android.graphics.Bitmap.Config.ARGB_8888);
        try (java.io.FileOutputStream output = new java.io.FileOutputStream(image)) { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output); }
        Bundle state = new Bundle(); state.putString("page", "外观");
        ActivityController<PiSettingsActivity> controller = Robolectric.buildActivity(PiSettingsActivity.class).create(state).start().resume().visible();
        try {
            // Hold the old decoded import at its commit boundary across Activity recreation.
            long oldImport = BackgroundImage.beginImport();
            org.robolectric.util.ReflectionHelpers.setField(controller.get(), "queryRunning", true);
            controller.recreate();
            View root = controller.get().getWindow().getDecorView();
            Button clear = findButton(root, "Clear imported image"); assertNotNull(clear); clear.performClick();
            assertFalse(BackgroundImage.commit(context, bitmap, oldImport));
            assertFalse(image.exists());
            assertEquals("solid", ui.getString("background", ""));
        } finally { bitmap.recycle(); controller.pause().stop().destroy(); }
    }

    @Test public void communityFiltersSurviveRecreationWithoutIssuingNetworkRequests() {
        ActivityController<PiSettingsActivity> controller = Robolectric.buildActivity(PiSettingsActivity.class).create().start().resume().visible();
        try {
            // The user has returned to Settings from the community page; retain its search state.
            org.robolectric.util.ReflectionHelpers.setField(controller.get(), "communityQuery", "my skills");
            org.robolectric.util.ReflectionHelpers.setField(controller.get(), "communityKind", "skill");
            org.robolectric.util.ReflectionHelpers.setField(controller.get(), "communityOffset", 20);
            controller.recreate();
            assertEquals("my skills", org.robolectric.util.ReflectionHelpers.<String>getField(controller.get(), "communityQuery"));
            assertEquals("skill", org.robolectric.util.ReflectionHelpers.<String>getField(controller.get(), "communityKind"));
            assertEquals(20, (int) org.robolectric.util.ReflectionHelpers.<Integer>getField(controller.get(), "communityOffset"));
        } finally { controller.pause().stop().destroy(); }
    }

    private static Button findButton(View view, String label) {
        if (view instanceof Button && ((Button) view).getText().toString().equals(label)) return (Button) view;
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) {
            Button found = findButton(((ViewGroup) view).getChildAt(i), label); if (found != null) return found;
        }
        return null;
    }

    private static EditText findEditor(View view) {
        if (view instanceof EditText) return (EditText) view;
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) {
            EditText found = findEditor(((ViewGroup) view).getChildAt(i)); if (found != null) return found;
        }
        return null;
    }

    private static boolean hasButton(View view, String label) {
        if (view instanceof Button && ((Button) view).getText().toString().equals(label)) return true;
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++)
            if (hasButton(((ViewGroup) view).getChildAt(i), label)) return true;
        return false;
    }
}
