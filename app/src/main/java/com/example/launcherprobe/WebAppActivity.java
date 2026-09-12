package com.example.launcherprobe;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

/** Non-exported Capacitor container; process-owned work remains in ChatCoordinator. */
public final class WebAppActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ChatPlugin.class);
        registerPlugin(SettingsPlugin.class);
        registerPlugin(DevicePlugin.class);
        super.onCreate(savedInstanceState);
        bridge.getWebView().getSettings().setTextZoom(Math.round(getResources().getConfiguration().fontScale * 100));
        if (savedInstanceState == null) {
            String prompt = getIntent().getStringExtra("prompt");
            String submissionId = getIntent().getStringExtra("submissionId");
            if (prompt != null && submissionId != null) try {
                ChatCoordinator.get(this).send(prompt, submissionId);
            } catch (Exception ignored) {
                // Snapshot/event recovery exposes the actual rejection to the Web UI.
            }
        }
    }

    @Override public void onConfigurationChanged(android.content.res.Configuration configuration) {
        super.onConfigurationChanged(configuration);
        bridge.getWebView().getSettings().setTextZoom(Math.round(configuration.fontScale * 100));
    }

    String launchRoute() { return getIntent().getStringExtra("route"); }
}
