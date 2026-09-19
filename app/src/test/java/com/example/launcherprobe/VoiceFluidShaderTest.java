package com.example.launcherprobe;

import android.app.Activity;
import android.content.Context;
import android.graphics.drawable.ColorDrawable;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.TextView;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class VoiceFluidShaderTest {
    @Test public void voiceWindowBlursBehindWithoutOpaqueBlackBackground() {
        try (org.robolectric.android.controller.ActivityController<Activity> controller = Robolectric.buildActivity(Activity.class).setup()) {
            Activity activity = controller.get();
            VoiceSession.applyGlass(activity.getWindow());
            WindowManager.LayoutParams attributes = activity.getWindow().getAttributes();
            assertTrue((attributes.flags & WindowManager.LayoutParams.FLAG_BLUR_BEHIND) != 0);
            assertEquals(90, attributes.getBlurBehindRadius());
            assertEquals(0, attributes.flags & WindowManager.LayoutParams.FLAG_DIM_BEHIND);
        }
    }

    @Test public void voicePageIsTransparentAndHasNoMuteButtonOrTitle() {
        Context context = RuntimeEnvironment.getApplication();
        SpeechOutput output = new SpeechOutput(context, new VoiceSettings(context));
        VoiceSession session = new VoiceSession(new VoiceSession.Host() {
            @Override public Context context() { return context; }
            @Override public void closed() { }
        }, output);
        try {
            View page = session.view();
            assertEquals(0, ((ColorDrawable) page.getBackground()).getColor());
            assertNoRemovedLabel(page);
        } finally { session.close(); output.shutdown(); }
    }

    private static void assertNoRemovedLabel(View view) {
        String text = view instanceof TextView ? ((TextView) view).getText().toString() : "";
        assertFalse(text.contains("静音"));
        assertNotEquals("小 E", text);
        assertFalse(String.valueOf(view.getContentDescription()).contains("静音"));
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) assertNoRemovedLabel(group.getChildAt(i));
        }
    }
}
