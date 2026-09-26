package com.example.launcherprobe;

import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.view.View;
import android.widget.ImageView;
import java.io.File;
import java.io.FileOutputStream;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class AssistantAppearanceTest {
    @Test public void workbenchUsesAssistantThemeInsteadOfLegacyDesktopPreference() {
        Context context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("launcher_desktop", 0).edit().putString("theme", "light").commit();
        context.getSharedPreferences("ui", 0).edit().putString("theme", "dark").commit();
        assertTrue(AppAppearance.readWorkbench(context).dark);
        assertTrue(AppAppearance.read(context).dark);
        assertEquals(0, AppAppearance.readWorkbench(context).systemBarFlags());

        context.getSharedPreferences("launcher_desktop", 0).edit().putString("theme", "dark").commit();
        context.getSharedPreferences("ui", 0).edit().putString("theme", "light").commit();
        assertFalse(AppAppearance.readWorkbench(context).dark);
        assertFalse(AppAppearance.read(context).dark);
        assertNotEquals(0, AppAppearance.readWorkbench(context).systemBarFlags());
    }

    @Test public void assistantAndWorkbenchFollowSystemNightMode() {
        Context context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("ui", 0).edit().putString("theme", "system").commit();
        for (int night : new int[]{Configuration.UI_MODE_NIGHT_YES, Configuration.UI_MODE_NIGHT_NO}) {
            Configuration configuration = new Configuration(context.getResources().getConfiguration());
            configuration.uiMode = (configuration.uiMode & ~Configuration.UI_MODE_NIGHT_MASK) | night;
            Context configured = context.createConfigurationContext(configuration);
            assertEquals(night == Configuration.UI_MODE_NIGHT_YES, AppAppearance.read(configured).dark);
            assertEquals(AppAppearance.read(configured).dark, AppAppearance.readWorkbench(configured).dark);
        }
    }

    @Test @org.robolectric.annotation.GraphicsMode(org.robolectric.annotation.GraphicsMode.Mode.NATIVE)
    public void assistantBackgroundKeepsPrivateImageAndIgnoresLegacySystemWallpaper() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("launcher_desktop", 0).edit().putString("wallpaper", "system").commit();
        context.getSharedPreferences("ui", 0).edit().putString("background", "solid").putInt("backgroundMask", 100).commit();
        AppAppearance colors = AppAppearance.read(context);
        View solid = colors.wallpaper(context);
        Bitmap rendered = Bitmap.createBitmap(4, 4, Bitmap.Config.ARGB_8888);
        solid.layout(0, 0, 4, 4);
        solid.draw(new Canvas(rendered));
        assertEquals(colors.background, rendered.getPixel(0, 0));
        assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO, solid.getImportantForAccessibility());
        assertEquals(255, Color.alpha(colors.maskColor(context)));

        File image = new File(context.getFilesDir(), "appearance/background.png");
        assertTrue(image.getParentFile().isDirectory() || image.getParentFile().mkdirs());
        try {
            try (FileOutputStream output = new FileOutputStream(image)) {
                assertTrue(rendered.compress(Bitmap.CompressFormat.PNG, 100, output));
            }
            context.getSharedPreferences("ui", 0).edit().putString("background", "image").commit();
            assertTrue(colors.wallpaper(context) instanceof ImageView);
            assertTrue(image.isFile());
        } finally {
            image.delete();
            rendered.recycle();
        }
    }
}
