package com.example.launcherprobe;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;
import java.util.List;

/** Read-only projection of the actual conversation and validated extension plan. */
public final class TaskDetailActivity extends Activity {
    public static final String EXTRA_CONVERSATION_ID = "task_conversation_id";
    public static final String EXTRA_OPEN_CHAT = "task_open_chat";
    private ChatCoordinator coordinator;
    private AppAppearance colors;
    private String id, signature = "";
    private LinearLayout content;
    private final ChatCoordinator.Listener listener = (messages, event) -> refresh();

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        coordinator = ChatCoordinator.get(this);
        colors = AppAppearance.readDesktop(this);
        id = getIntent().getStringExtra(EXTRA_CONVERSATION_ID);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(colors.background);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                view.setPadding(bars.left + dp(20), bars.top, bars.right + dp(20), bars.bottom);
            } else {
                view.setPadding(insets.getSystemWindowInsetLeft() + dp(20), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight() + dp(20), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        TextView back = label("‹   任务详情", 22); back.setMinHeight(dp(56));
        back.setGravity(Gravity.CENTER_VERTICAL); back.setOnClickListener(v -> finish()); back.setFocusable(true);
        root.addView(back);
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true);
        content = new LinearLayout(this); content.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(content); root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(root); refresh();
    }

    @Override protected void onStart() { super.onStart(); coordinator.addListener(listener); refresh(); }
    @Override protected void onStop() { coordinator.removeListener(listener); super.onStop(); }

    private void refresh() {
        JSONObject card = id == null ? null : coordinator.taskCard(id);
        if (card == null) { finish(); return; }
        if (card.toString().equals(signature)) return;
        signature = card.toString(); content.removeAllViews();
        content.addView(label("✦  " + card.optString("title"), 23));
        TextView status = label(HomeTaskCards.status(card), 16); status.setTextColor(colors.accent);
        content.addView(status);
        List<JSONObject> tasks = HomeTaskCards.tasks(card);
        if (!tasks.isEmpty()) {
            int completed = (int) tasks.stream().filter(t -> "completed".equals(t.optString("status"))).count();
            content.addView(label("已完成 " + completed + " 项，共 " + tasks.size() + " 项     "
                    + completed * 100 / tasks.size() + "%", 15));
            ProgressBar progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
            progress.setMax(tasks.size()); progress.setProgress(completed);
            progress.setProgressTintList(ColorStateList.valueOf(colors.accent));
            content.addView(progress, new LinearLayout.LayoutParams(-1, dp(10)));
            for (JSONObject task : tasks) {
                String state = task.optString("status");
                boolean done = "completed".equals(state), active = "in_progress".equals(state);
                TextView step = label((done ? "✓  " : active ? "◉  " : "○  ") + task.optString("subject")
                        + "\n     " + (done ? "已完成" : active ? "进行中" : "等待中"), 16);
                step.setTextColor(done || active ? colors.accent : colors.muted); content.addView(step);
            }
        }
        content.addView(label("任务信息", 18));
        long created = card.optLong("created");
        content.addView(label("创建时间    " + (created == 0 ? "旧会话未记录" :
                android.text.format.DateFormat.getMediumDateFormat(this).format(new java.util.Date(created)) + " "
                + android.text.format.DateFormat.getTimeFormat(this).format(new java.util.Date(created))), 14));
        content.addView(label("运行方式    后台运行", 14));
        String error = card.optString("error");
        if (!error.isEmpty()) { TextView text = label(error, 15); text.setTextColor(colors.error); content.addView(text); }
        String response = card.optString("result");
        if (!response.isEmpty()) {
            content.addView(label("最新回复", 18));
            TextView result = label(response, 15); result.setTextIsSelectable(true); content.addView(result);
        }
        LinearLayout actions = new LinearLayout(this);
        boolean busy = !"idle".equals(card.optString("modelState"));
        TextView left = label(busy ? "停止" : "删除", 17); left.setGravity(Gravity.CENTER);
        left.setTextColor(colors.error); left.setFocusable(true); left.setMinHeight(dp(56));
        left.setEnabled(!"stopping".equals(card.optString("modelState")));
        left.setOnClickListener(v -> {
            if (busy) { coordinator.cancel(id); refresh(); }
            else new AlertDialog.Builder(this).setTitle("删除对话？")
                    .setMessage("同时删除聊天历史与工作区；移除桌面小组件不会删除历史。")
                    .setNegativeButton("取消", null).setPositiveButton("删除", (dialog, which) -> {
                        try { coordinator.deleteConversation(id); finish(); }
                        catch (RuntimeException e) { Toast.makeText(this, e.getMessage(), Toast.LENGTH_LONG).show(); refresh(); }
                    }).show();
        });
        actions.addView(left, new LinearLayout.LayoutParams(0, -2, 1));
        TextView chat = label("查看对话", 17); chat.setGravity(Gravity.CENTER); chat.setTextColor(colors.accent);
        chat.setMinHeight(dp(56)); chat.setFocusable(true);
        chat.setOnClickListener(v -> {
            startActivity(new Intent(this, MainActivity.class).putExtra(EXTRA_OPEN_CHAT, id)
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)); finish();
        });
        actions.addView(chat, new LinearLayout.LayoutParams(0, -2, 1)); content.addView(actions);
        TextView home = label("回到桌面", 15); home.setTextColor(colors.accent); home.setGravity(Gravity.CENTER);
        home.setFocusable(true); home.setOnClickListener(v -> {
            startActivity(new Intent(this, MainActivity.class).setAction(Intent.ACTION_MAIN)
                    .addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP));
            finish();
        }); content.addView(home);
    }

    private TextView label(String text, int size) {
        TextView view = new TextView(this); view.setText(text); view.setTextSize(size);
        view.setTextColor(colors.ink); view.setPadding(0, dp(12), 0, dp(12)); return view;
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
