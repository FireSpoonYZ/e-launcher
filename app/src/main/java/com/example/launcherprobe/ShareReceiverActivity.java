package com.example.launcherprobe;

import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** Preview and explicit draft import only. Sending remains the chat composer's responsibility. */
public final class ShareReceiverActivity extends ComponentActivity {
    private String token;
    private ShareIntake intake;
    private Spinner destination;
    private final List<String> ids = new ArrayList<>();
    private Button confirm, cancel;
    private TextView status;
    private ImportJob job;

    private static final class ImportJob {
        ShareReceiverActivity owner;
        boolean done;
        String id, error;
    }

    @Override public void onCreate(Bundle state) {
        AppAppearance colors = AppAppearance.readWorkbench(this); colors.apply(this);
        super.onCreate(state); colors.applySystemBars(this, colors.background);
        token = state == null ? UUID.randomUUID().toString() : state.getString("share_token");
        job = (ImportJob) getLastCustomNonConfigurationInstance();
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(colors.background);
        int padding = (int) (20 * getResources().getDisplayMetrics().density);
        root.setPadding(padding, padding, padding, padding);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            androidx.core.graphics.Insets bars = androidx.core.view.WindowInsetsCompat.toWindowInsetsCompat(insets, view)
                    .getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars());
            view.setPadding(padding + bars.left, padding + bars.top, padding + bars.right, padding + bars.bottom);
            return insets;
        });
        TextView heading = new TextView(this); heading.setText("导入分享"); heading.setTextSize(22);
        heading.setTextColor(colors.ink); root.addView(heading);
        TextView hint = new TextView(this); hint.setText("追加到草稿，不会自动发送。打开会话后填写要求，再主动发送。");
        hint.setTextColor(colors.muted); root.addView(hint);
        ScrollView scroll = new ScrollView(this);
        TextView preview = new TextView(this); preview.setTextColor(colors.ink); preview.setTextSize(16);
        preview.setTextIsSelectable(true); preview.setPadding(0, padding, 0, padding); scroll.addView(preview);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        destination = new Spinner(this); destination.setContentDescription("导入到会话");
        List<String> titles = new ArrayList<>(); titles.add("新会话"); ids.add(null);
        for (ChatStore.Conversation conversation : new ChatStore(this).conversations()) {
            ids.add(conversation.id); titles.add(conversation.title);
        }
        String restoredTarget = state == null ? null : state.getString("share_target");
        if (restoredTarget != null && !ids.contains(restoredTarget)) {
            ids.add(restoredTarget); titles.add("原会话已不可写，请重新选择");
        }
        ArrayAdapter<String> adapter = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item, titles);
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item); destination.setAdapter(adapter);
        if (state != null && ids.contains(state.getString("share_target")))
            destination.setSelection(ids.indexOf(state.getString("share_target")));
        root.addView(destination);
        status = new TextView(this); status.setTextColor(colors.ink);
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); root.addView(status);
        confirm = new Button(this); confirm.setText("追加到草稿并打开会话"); root.addView(confirm);
        cancel = new Button(this); cancel.setText("取消"); root.addView(cancel);
        cancel.setOnClickListener(v -> finish());
        confirm.setOnClickListener(v -> importDraft());
        setContentView(root);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                if (job == null || job.done) finish();
                else status.setText("正在保存草稿，请稍候");
            }
        });
        try {
            intake = ShareIntake.parse(getIntent());
            StringBuilder content = new StringBuilder(intake.text);
            for (int i = 0; i < intake.uris.size(); i++) {
                ShareIntake.requireGrant(this, intake.uris.get(i));
                content.append("\n\n附件 ").append(i + 1).append("：")
                        .append(intake.uris.get(i).getLastPathSegment());
            }
            preview.setText(content);
        } catch (Exception exception) {
            status.setText("无法导入：" + exception.getMessage()); confirm.setEnabled(false);
        }
        if (job == null && state != null) {
            String saved = getSharedPreferences("chat", MODE_PRIVATE).getString("share_intake_" + token, null);
            if (saved != null) { job = new ImportJob(); job.done = true; job.id = saved; }
        }
        if (job != null) { job.owner = this; showJob(); }
    }

    private void importDraft() {
        if (job != null && !job.done) return;
        job = new ImportJob(); job.owner = this;
        ImportJob running = job;
        String target = ids.get(destination.getSelectedItemPosition());
        ShareIntake input = intake;
        android.content.Context context = getApplicationContext();
        String operation = token;
        showJob();
        new Thread(() -> {
            String id = null, error = null;
            try { id = input.importDraft(context, operation, target); }
            catch (Exception exception) { error = "导入失败，原草稿未改动：" + exception.getMessage(); }
            String result = id, failure = error;
            new Handler(Looper.getMainLooper()).post(() -> {
                running.id = result; running.error = failure; running.done = true;
                if (running.owner != null) running.owner.showJob();
            });
        }, "share-intake").start();
    }

    private void showJob() {
        confirm.setEnabled(job.done && intake != null); cancel.setEnabled(job.done); destination.setEnabled(job.done);
        status.setText(job.done ? job.error : "正在导入，请稍候…");
        if (job.done && job.id != null) {
            startActivity(new Intent(this, MainActivity.class)
                    .putExtra(TaskDetailActivity.EXTRA_OPEN_CHAT, job.id)
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP));
            finish();
        }
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        state.putString("share_token", token);
        state.putString("share_target", ids.get(destination.getSelectedItemPosition()));
        super.onSaveInstanceState(state);
    }

    @Override public Object onRetainCustomNonConfigurationInstance() { return job; }

    @Override protected void onDestroy() {
        if (job != null && job.owner == this) job.owner = null;
        super.onDestroy();
    }
}
