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
    @Test public void nativeCredentialAliasNeedsConsentAndMcpJsonHasAccessibleLabel() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("ui", 0).edit().clear().putString("language", "zh").commit();
        PiConfigStore store = new PiConfigStore(context);
        store.save(false, "mcp-auth.json", "{\"token\":\"fixture-private\"}", null);
        assertTrue(store.isCredentialFile(false, "./mcp-auth.json"));
        assertTrue(store.isCredentialFile(false, "./mcp-auth.json.previous"));
        assertTrue(store.isCredentialFile(false, "./auth.json"));
        assertTrue(store.isMcpConfigFile(false, "./mcp.json"));
        ActivityController<PiSettingsActivity> controller = Robolectric.buildActivity(PiSettingsActivity.class).create().start().resume().visible();
        try {
            org.robolectric.util.ReflectionHelpers.callInstanceMethod(controller.get(), "openFile",
                    org.robolectric.util.ReflectionHelpers.ClassParameter.from(String.class, "./mcp-auth.json"));
            android.app.AlertDialog consent = org.robolectric.shadows.ShadowAlertDialog.getLatestAlertDialog();
            assertTrue(consent.isShowing());
            assertEquals("设置", org.robolectric.util.ReflectionHelpers.<String>getField(controller.get(), "page"));
            consent.dismiss();
            org.robolectric.util.ReflectionHelpers.callInstanceMethod(controller.get(), "mcpForm",
                    org.robolectric.util.ReflectionHelpers.ClassParameter.from(String.class, ""),
                    org.robolectric.util.ReflectionHelpers.ClassParameter.from(String.class, "global"),
                    org.robolectric.util.ReflectionHelpers.ClassParameter.from(String.class, "fixture-revision"),
                    org.robolectric.util.ReflectionHelpers.ClassParameter.from(org.json.JSONObject.class, new org.json.JSONObject()));
            View dialog = org.robolectric.shadows.ShadowAlertDialog.getLatestAlertDialog().getWindow().getDecorView();
            assertNotNull(findDescription(dialog, "MCP JSON: env / headers / oauth / timeout / cwd"));
        } finally { controller.pause().stop().destroy(); }
    }

    private static View findDescription(View view, String description) {
        if (description.contentEquals(view.getContentDescription() == null ? "" : view.getContentDescription())) return view;
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) {
            View found = findDescription(((ViewGroup) view).getChildAt(i), description); if (found != null) return found;
        }
        return null;
    }

    @Test public void changingLanguageAndThemePreservesInvalidDraftAndSavedValues() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("ui", 0).edit().clear().putString("language", "en").putString("theme", "light").commit();
        context.getSharedPreferences("PiSettingsActivity", 0).edit().clear().commit();
        PiConfigStore store = new PiConfigStore(context);
        store.initialize(context.getSharedPreferences("chat", 0));
        Files.createDirectories(store.directory(false).toPath());
        String saved = "{\"customText\":\"保存\",\"customNumber\":1e+02}\n";
        Files.write(store.directory(false).toPath().resolve("settings.json"), saved.getBytes(StandardCharsets.UTF_8));
        String legacyProject = "{\"customText\":\"旧项目配置\"}\n";
        Files.createDirectories(store.directory(true).toPath());
        Files.write(store.directory(true).toPath().resolve("settings.json"), legacyProject.getBytes(StandardCharsets.UTF_8));
        Bundle state = new Bundle(); state.putString("page", "file:settings.json"); state.putBoolean("project", true);
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
            assertEquals(legacyProject, store.read(true, "settings.json"));
            assertFalse(hasButton(root, "工作区 ▾"));
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

    @Test public void extensionPageKeepsPermanentNpmInstallerInputAcrossRecreation() {
        Context context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("ui", 0).edit().clear().putString("language", "en").commit();
        Bundle state = new Bundle(); state.putString("page", "扩展");
        ActivityController<PiSettingsActivity> controller = Robolectric.buildActivity(PiSettingsActivity.class).create(state).start().resume().visible();
        try {
            View root = controller.get().getWindow().getDecorView();
            EditText npm = findInput(root, "npm package name, optionally with a version"); assertNotNull(npm);
            assertTrue(hasButton(root, "Install npm extension"));
            npm.setText("@scope/demo@1.2.3");
            controller.recreate();
            npm = findInput(controller.get().getWindow().getDecorView(), "npm package name, optionally with a version");
            assertNotNull(npm); assertEquals("@scope/demo@1.2.3", npm.getText().toString());
        } finally { controller.pause().stop().destroy(); }
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

    private static EditText findInput(View view, String hint) {
        if (view instanceof EditText && hint.equals(((EditText) view).getHint())) return (EditText) view;
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) {
            EditText found = findInput(((ViewGroup) view).getChildAt(i), hint); if (found != null) return found;
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
