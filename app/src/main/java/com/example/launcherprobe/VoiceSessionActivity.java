package com.example.launcherprobe;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.view.WindowManager;

/** Full-screen host for a spoken conversation while the launcher itself is in front. */
public final class VoiceSessionActivity extends Activity implements VoiceSession.Host {
    private static final int REQUEST_MICROPHONE = 61;
    static final String EXTRA_CONVERSATION_ID = "voiceConversationId";

    private VoiceSession session;

    /** Opens the conversation over the given screen; no-op when the microphone was refused. */
    static void open(Context from, boolean fromWake) {
        open(from, fromWake, null);
    }

    static void open(Context from, boolean fromWake, String conversationId) {
        from.startActivity(new Intent(from, VoiceSessionActivity.class)
                .putExtra(LauncherVoiceInteractionService.EXTRA_WAKE, fromWake)
                .putExtra(EXTRA_CONVERSATION_ID, conversationId));
    }

    @Override public Context context() { return this; }

    @Override public void closed() { finish(); }

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        VoiceSession.applyGlass(getWindow());
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_MICROPHONE);
            return;
        }
        begin();
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request != REQUEST_MICROPHONE) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) begin();
        else finish();
    }

    @Override protected void onDestroy() {
        if (session != null) session.close();
        session = null;
        super.onDestroy();
    }

    private void begin() {
        session = VoiceManager.get(this).openSession(this, getIntent().getStringExtra(EXTRA_CONVERSATION_ID));
        setContentView(session.view());
        session.start(getIntent().getBooleanExtra(LauncherVoiceInteractionService.EXTRA_WAKE, false));
    }
}
