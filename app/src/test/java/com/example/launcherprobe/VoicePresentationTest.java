package com.example.launcherprobe;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.media.MediaPlayer;
import android.view.View;
import android.view.ViewGroup;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;
import org.robolectric.shadows.ShadowMediaPlayer;
import org.robolectric.shadows.ShadowSpeechRecognizer;

import java.io.FileOutputStream;

import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class VoicePresentationTest {
    @Test public void assistStartsListeningWithoutGreetingOrCreatingChat() {
        Context context = RuntimeEnvironment.getApplication();
        MediaPlayer[] player = {null};
        ShadowMediaPlayer.setCreateListener((created, shadow) -> player[0] = created);
        SpeechOutput output = new SpeechOutput(context, new VoiceSettings(context));
        VoiceSession session = session(context, output);
        String before = ChatCoordinator.get(context).conversationId();
        try {
            session.start(false);
            assertNull("The power-key entry must not play a greeting", player[0]);
            assertNotNull(ShadowSpeechRecognizer.getLatestSpeechRecognizer());
            assertEquals(before, ChatCoordinator.get(context).conversationId());
        } finally { session.close(); output.shutdown(); }
    }

    @Test public void wakeWaitsForGreetingBeforeOpeningRecognizer() {
        Context context = RuntimeEnvironment.getApplication();
        MediaPlayer[] player = {null};
        ShadowMediaPlayer.setCreateListener((created, shadow) -> player[0] = created);
        ShadowMediaPlayer.setMediaInfoProvider(source -> new ShadowMediaPlayer.MediaInfo(1000, 0));
        SpeechOutput output = new SpeechOutput(context, new VoiceSettings(context));
        VoiceSession session = session(context, output);
        String before = ChatCoordinator.get(context).conversationId();
        try {
            session.start(true);
            assertNotNull(player[0]);
            assertTrue(player[0].isPlaying());
            assertNull(ShadowSpeechRecognizer.getLatestSpeechRecognizer());
            Shadows.shadowOf(player[0]).invokeCompletionListener();
            assertNotNull(ShadowSpeechRecognizer.getLatestSpeechRecognizer());
            assertEquals(before, ChatCoordinator.get(context).conversationId());
        } finally { session.close(); output.shutdown(); }
    }

    @Test public void voiceDetectionSpeedsFlowButVolumeAloneDoesNot() {
        VoiceOrbView e = new VoiceOrbView(RuntimeEnvironment.getApplication());
        float resting = e.flowSpeed();
        e.setLevel(1);
        for (int i = 0; i < 60; i++) e.advance(1f / 60);
        assertEquals("Noise must not drive flow speed", resting, e.flowSpeed(), .001f);
        e.setUserSpeaking(true);
        for (int i = 0; i < 30; i++) e.advance(1f / 60);
        float talking = e.flowSpeed();
        assertTrue(talking > resting * 4);
        e.setUserSpeaking(false);
        e.advance(1f / 60);
        assertTrue("Return to rest should not snap", e.flowSpeed() > resting * 3);
        for (int i = 0; i < 240; i++) e.advance(1f / 60);
        assertEquals(resting, e.flowSpeed(), .005f);
        e.setState(VoiceOrbView.State.MUTED);
        e.setUserSpeaking(true);
        for (int i = 0; i < 60; i++) e.advance(1f / 60);
        assertTrue(e.flowSpeed() < resting);
        e.setState(VoiceOrbView.State.THINKING);
        assertEquals(resting, e.flowSpeed(), .001f);
        e.setState(VoiceOrbView.State.SPEAKING);
        float quiet = e.flowSpeed();
        assertEquals(resting, quiet, .001f);
        e.setLevel(1);
        for (int i = 0; i < 30; i++) e.advance(1f / 60);
        assertTrue(e.flowSpeed() > quiet + .3f);
    }

    @Test public void flowSpeedFollowsElapsedTimeNotFrameCount() {
        VoiceOrbView a = new VoiceOrbView(RuntimeEnvironment.getApplication());
        VoiceOrbView b = new VoiceOrbView(RuntimeEnvironment.getApplication());
        a.setUserSpeaking(true);
        b.setUserSpeaking(true);
        for (int i = 0; i < 30; i++) a.advance(1f / 60);
        for (int i = 0; i < 5; i++) b.advance(.1f);
        assertEquals(a.flowSpeed(), b.flowSpeed(), .01f);
    }

    @Test @Config(sdk = 29) @GraphicsMode(GraphicsMode.Mode.NATIVE)
    public void api29DrawsBlueWhiteFallbackWithoutRuntimeShader() throws Exception {
        VoiceOrbView e = new VoiceOrbView(RuntimeEnvironment.getApplication());
        e.measure(View.MeasureSpec.makeMeasureSpec(240, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(240, View.MeasureSpec.EXACTLY));
        e.layout(0, 0, 240, 240);
        assertFalse(e.fluidShaderReady());
        Bitmap bitmap = Bitmap.createBitmap(240, 240, Bitmap.Config.ARGB_8888);
        e.draw(new Canvas(bitmap));
        int opaque = 0, pink = 0, blue = 0, bright = 0;
        for (int y = 0; y < 240; y += 2) for (int x = 0; x < 240; x += 2) {
            int colour = bitmap.getPixel(x, y);
            int a = (colour >>> 24) & 255;
            if (a < 200) continue;
            opaque++;
            int r = (colour >> 16) & 255, g = (colour >> 8) & 255, b = colour & 255;
            if (g * 1.15f < r && g * 1.15f < b) pink++;
            if (b > r + 40 && b > 120) blue++;
            if (r > 190 && g > 200 && b > 190) bright++;
        }
        assertTrue("e should cover a solid area", opaque > 200);
        assertEquals("fallback must not keep pink/purple overlays", 0, pink);
        assertTrue(blue > 20);
        assertTrue(bright > 5);
        try (FileOutputStream out = new FileOutputStream(
                "D:/tmp/codex-voice-research-20260919/voice-e-fallback-preview.png")) {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
        }
    }

    @Test public void eSitsInLowerPartWithoutClippingOnShortScreens() {
        Context context = RuntimeEnvironment.getApplication();
        SpeechOutput output = new SpeechOutput(context, new VoiceSettings(context));
        VoiceSession session = session(context, output);
        try {
            View root = session.view();
            for (int[] size : new int[][]{{412, 915}, {320, 568}, {915, 412}}) {
                root.measure(View.MeasureSpec.makeMeasureSpec(size[0], View.MeasureSpec.EXACTLY),
                        View.MeasureSpec.makeMeasureSpec(size[1], View.MeasureSpec.EXACTLY));
                root.layout(0, 0, size[0], size[1]);
                VoiceOrbView e = findE(root);
                assertNotNull(e);
                View stage = (View) e.getParent();
                assertTrue(e.getWidth() > 60);
                assertTrue(e.getTop() >= 0);
                assertTrue(e.getBottom() <= stage.getHeight());
                assertTrue((e.getTop() + e.getBottom()) / 2f > stage.getHeight() * .6f);
            }
        } finally { session.close(); output.shutdown(); }
    }

    private static VoiceSession session(Context context, SpeechOutput output) {
        VoiceSession session = new VoiceSession(new VoiceSession.Host() {
            @Override public Context context() { return context; }
            @Override public void closed() { }
        }, output);
        session.view();
        return session;
    }

    private static VoiceOrbView findE(View view) {
        if (view instanceof VoiceOrbView) return (VoiceOrbView) view;
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) view).getChildCount(); i++) {
            VoiceOrbView found = findE(((ViewGroup) view).getChildAt(i));
            if (found != null) return found;
        }
        return null;
    }
}
