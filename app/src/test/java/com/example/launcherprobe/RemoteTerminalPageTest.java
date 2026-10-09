package com.example.launcherprobe;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Looper;
import androidx.appcompat.app.AppCompatActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import static org.junit.Assert.*;
import static org.robolectric.Shadows.shadowOf;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, shadows = RemoteTerminalPageTest.PluginContext.class)
public class RemoteTerminalPageTest {
    @Implements(Plugin.class)
    public static class PluginContext {
        @Implementation protected Context getContext() { return RuntimeEnvironment.getApplication(); }
        @Implementation protected AppCompatActivity getActivity() { return null; }
    }
    private static final class Call extends PluginCall {
        JSObject value;
        String error;
        boolean resolved;
        Call(JSObject data) { super(null, "RemoteTerminal", "test", "clipboard", data); }
        @Override public void resolve(JSObject value) { this.value = value; resolved = true; }
        @Override public void resolve() { resolved = true; }
        @Override public void reject(String message, String code) { error = code; }
    }

    @Test public void clipboardIsExplicitTextOnlyBoundedAndErrorsAreVisible() {
        RemoteTerminalPlugin plugin = new RemoteTerminalPlugin();
        ClipboardManager clipboard = (ClipboardManager) RuntimeEnvironment.getApplication()
                .getSystemService(Context.CLIPBOARD_SERVICE);
        clipboard.setPrimaryClip(ClipData.newPlainText("test", "你好"));
        Call read = new Call(new JSObject());
        plugin.readClipboard(read); shadowOf(Looper.getMainLooper()).idle();
        assertTrue(read.resolved); assertEquals("你好", read.value.getString("text"));
        Call write = new Call(new JSObject().put("text", "selection"));
        plugin.writeClipboard(write); shadowOf(Looper.getMainLooper()).idle();
        assertTrue(write.resolved);
        assertEquals("selection", clipboard.getPrimaryClip().getItemAt(0).getText());
        clipboard.setPrimaryClip(ClipData.newPlainText("test", "中".repeat(21846)));
        Call large = new Call(new JSObject());
        plugin.readClipboard(large); shadowOf(Looper.getMainLooper()).idle();
        assertFalse(large.resolved); assertEquals("CLIPBOARD_ERROR", large.error);
        clipboard.setPrimaryClip(ClipData.newRawUri("image", android.net.Uri.parse("content://image/1")));
        Call image = new Call(new JSObject());
        plugin.readClipboard(image); shadowOf(Looper.getMainLooper()).idle();
        assertEquals("CLIPBOARD_ERROR", image.error);
        Call invalid = new Call(new JSObject().put("text", 1));
        plugin.writeClipboard(invalid); shadowOf(Looper.getMainLooper()).idle();
        assertEquals("CLIPBOARD_ERROR", invalid.error);
        plugin.handleOnDestroy();
    }
    @Test public void pageZoomRejectsInvalidPageScopeInsteadOfTouchingGlobalFontSettings() {
        RemoteTerminalPlugin plugin = new RemoteTerminalPlugin();
        Call invalid = new Call(new JSObject().put("token", "page").put("active", "true"));
        plugin.setTerminalPage(invalid); shadowOf(Looper.getMainLooper()).idle();
        assertEquals("TERMINAL_ERROR", invalid.error);
        Call noActivity = new Call(new JSObject().put("token", "page").put("active", true));
        plugin.setTerminalPage(noActivity); shadowOf(Looper.getMainLooper()).idle();
        assertEquals("TERMINAL_ERROR", noActivity.error);
        plugin.handleOnDestroy();
    }
}
