package com.example.launcherprobe;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Typeface;
import android.graphics.drawable.ScaleDrawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.LayerDrawable;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.ImageView;
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
    public static final String EXTRA_ARCHIVED_ID = "task_archived_id";
    private ChatCoordinator coordinator;
    private AppAppearance colors;
    private String id, signature = "";
    private LinearLayout content, footer;
    private TextView latestReply;
    private boolean replyExpanded;
    private JSONObject currentCard;
    private final ChatCoordinator.Listener listener = (messages, event) -> refresh();

    @Override public void onCreate(Bundle state) {
        colors = AppAppearance.readDesktop(this); colors.apply(this);
        super.onCreate(state); colors.applySystemBars(this, colors.background);
        coordinator = ChatCoordinator.get(this); id = getIntent().getStringExtra(EXTRA_CONVERSATION_ID);
        replyExpanded = state != null && state.getBoolean("reply_expanded");
        LinearLayout root = column(); root.setBackgroundColor(colors.background);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            androidx.core.graphics.Insets bars = androidx.core.view.WindowInsetsCompat.toWindowInsetsCompat(insets, view)
                    .getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars()
                            | androidx.core.view.WindowInsetsCompat.Type.displayCutout());
            view.setPadding(bars.left + dp(20), bars.top, bars.right + dp(20), bars.bottom); return insets;
        });
        LinearLayout header = row();
        ImageView back = new ImageView(this); back.setImageDrawable(new ChatIcon("previous", colors.ink));
        back.setPadding(0, dp(12), dp(16), dp(12)); back.setContentDescription("返回");
        back.setFocusable(true); back.setOnClickListener(v -> finish());
        header.addView(back, new LinearLayout.LayoutParams(dp(40), dp(48)));
        TextView heading = label("任务详情", 19, colors.ink); heading.setTypeface(null, Typeface.BOLD);
        header.addView(heading); root.addView(header, new LinearLayout.LayoutParams(-1, dp(48)));
        ScrollView scroll = new ScrollView(this); scroll.setVerticalScrollBarEnabled(false);
        content = column(); content.setPadding(0, dp(10), 0, dp(8)); scroll.addView(content);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        footer = column(); footer.setPadding(0, dp(10), 0, 0); root.addView(footer);
        setContentView(root); root.requestApplyInsets(); refresh();
    }
    @Override public void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state); state.putBoolean("reply_expanded", replyExpanded);
    }
    @Override protected void onStart() { super.onStart(); coordinator.addListener(listener); refresh(); }
    @Override protected void onResume() {
        super.onResume();
        new Thread(() -> {
            try { coordinator.purgeExpiredArchives(); }
            catch (RuntimeException ignored) { }
            if (isFinishing()) return;
            runOnUiThread(() -> { if (!isFinishing()) refresh(); });
        }, "archive-purge").start();
    }
    @Override protected void onStop() { coordinator.removeListener(listener); super.onStop(); }

    private void refresh() {
        JSONObject card = id == null ? null : coordinator.taskCard(id);
        if (card == null) { finish(); return; }
        currentCard = card;
        if (latestReply != null && replyExpanded) latestReply.setText(card.optString("result"));
        String model = card.optString("modelState");
        String next = String.join("|", card.optString("title"), model, card.optString("runStatus"),
                String.valueOf(card.opt("todo")), card.optString("error"), String.valueOf(card.optString("result").isEmpty()));
        if (next.equals(signature)) return;
        signature = next; content.removeAllViews(); footer.removeAllViews(); latestReply = null;
        LinearLayout overview = row(); overview.setPadding(0, 0, 0, dp(16));
        ImageView symbol = new ImageView(this); symbol.setImageDrawable(new ChatIcon("sparkles", colors.accent));
        symbol.setBackground(shape(colors.panel, 16)); symbol.setPadding(dp(14), dp(14), dp(14), dp(14));
        overview.addView(symbol, new LinearLayout.LayoutParams(dp(64), dp(64)));
        LinearLayout titles = column(); titles.setPadding(dp(14), 0, 0, 0);
        TextView title = label(card.optString("title"), 18, colors.ink); title.setTypeface(null, Typeface.BOLD);
        title.setMaxLines(3); title.setEllipsize(android.text.TextUtils.TruncateAt.END); titles.addView(title);
        TextView state = label(HomeTaskCards.status(card), 14, "error".equals(card.optString("runStatus")) ? colors.error : colors.accent);
        state.setPadding(0, dp(6), 0, 0); titles.addView(state);
        overview.addView(titles, new LinearLayout.LayoutParams(0, -2, 1)); content.addView(overview);

        List<JSONObject> tasks = HomeTaskCards.tasks(card);
        if (!tasks.isEmpty()) {
            int completed = (int) tasks.stream().filter(t -> "completed".equals(t.optString("status"))).count();
            LinearLayout summary = row();
            summary.addView(label("已完成 " + completed + " 项，共 " + tasks.size() + " 项", 13, colors.muted), new LinearLayout.LayoutParams(0, -2, 1));
            summary.addView(label(completed * 100 / tasks.size() + "%", 13, colors.muted)); content.addView(summary);
            ProgressBar progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
            ScaleDrawable fill = new ScaleDrawable(shape(colors.accent, 6), Gravity.LEFT, 1f, -1f);
            LayerDrawable track = new LayerDrawable(new android.graphics.drawable.Drawable[]{shape(colors.panel, 6), fill});
            track.setId(0, android.R.id.background); track.setId(1, android.R.id.progress);
            progress.setProgressDrawable(track); progress.setMax(tasks.size()); progress.setProgress(completed);
            LinearLayout.LayoutParams progressParams = new LinearLayout.LayoutParams(-1, dp(8));
            progressParams.setMargins(0, dp(8), 0, dp(14)); content.addView(progress, progressParams);
            for (JSONObject task : tasks) {
                LinearLayout step = row(); step.setMinimumHeight(dp(46)); step.setPadding(0, dp(5), 0, dp(5));
                String status = task.optString("status");
                boolean done = "completed".equals(status), active = "in_progress".equals(status);
                step.addView(new TaskStepMarker(this, status, model, 0xff10b569), new LinearLayout.LayoutParams(dp(30), dp(32)));
                TextView subject = label(task.optString("subject"), 14, colors.ink);
                subject.setPadding(dp(8), 0, dp(12), 0); subject.setMaxLines(3);
                subject.setEllipsize(android.text.TextUtils.TruncateAt.END);
                step.addView(subject, new LinearLayout.LayoutParams(0, -2, 1));
                step.addView(label(done ? "已完成" : active ? ("working".equals(model) ? "进行中" : "未完成") : "等待中", 12,
                        active && "working".equals(model) ? colors.accent : colors.muted));
                content.addView(step); divider(1, 0);
            }
        }
        divider(5, 14);
        TextView information = label("任务信息", 16, colors.ink); information.setTypeface(null, Typeface.BOLD);
        information.setPadding(0, 0, 0, dp(6)); content.addView(information);
        long created = card.optLong("created");
        info("创建时间", created == 0 ? "旧会话未记录" : android.text.format.DateFormat.format("M月d日 HH:mm", created).toString());
        info("运行方式", "后台运行");
        String error = card.optString("error");
        if (!error.isEmpty() && "error".equals(card.optString("runStatus"))) { TextView warning = label(error, 13, colors.error); warning.setPadding(0, dp(8), 0, dp(8)); content.addView(warning); }
        if (!card.optString("result").isEmpty()) {
            TextView toggle = label(replyExpanded ? "收起最新回复" : "查看最新回复", 13, colors.accent);
            toggle.setMinHeight(dp(40)); toggle.setGravity(Gravity.CENTER_VERTICAL); toggle.setFocusable(true);
            content.addView(toggle);
            latestReply = label(card.optString("result"), 14, colors.ink); latestReply.setTextIsSelectable(true);
            latestReply.setVisibility(replyExpanded ? View.VISIBLE : View.GONE); content.addView(latestReply);
            toggle.setOnClickListener(v -> {
                replyExpanded = !replyExpanded;
                latestReply.setText(currentCard.optString("result")); latestReply.setVisibility(replyExpanded ? View.VISIBLE : View.GONE);
                toggle.setText(replyExpanded ? "收起最新回复" : "查看最新回复");
            });
        }
        LinearLayout actions = row();
        boolean busy = !"idle".equals(model);
        TextView left = button("stopping".equals(model) ? "正在停止…" : busy ? "停止" : "归档", colors.error);
        GradientDrawable warning = shape(colors.dark ? 0xff432d38 : 0xfffff1f3, 14);
        warning.setStroke(dp(1), colors.dark ? colors.error : 0xffffb1b8); left.setBackground(warning);
        left.setEnabled(!"stopping".equals(model)); left.setOnClickListener(v -> {
            if (busy) { coordinator.cancel(id); refresh(); }
            else archive();
        });
        actions.addView(left, new LinearLayout.LayoutParams(0, dp(48), 1));
        TextView chat = button("查看对话", 0xffffffff); chat.setBackground(shape(colors.accent, 14));
        chat.setOnClickListener(v -> openChat(id));
        LinearLayout.LayoutParams chatParams = new LinearLayout.LayoutParams(0, dp(48), 1); chatParams.leftMargin = dp(10);
        actions.addView(chat, chatParams); footer.addView(actions);
        if (busy) {
            TextView archive = button("归档", colors.accent); archive.setTextSize(14);
            archive.setOnClickListener(v -> archive());
            footer.addView(archive, new LinearLayout.LayoutParams(-1, dp(48)));
        }
        TextView remove = button("永久删除", colors.error); remove.setTextSize(14);
        remove.setOnClickListener(v -> confirmPermanentDelete());
        footer.addView(remove, new LinearLayout.LayoutParams(-1, dp(48)));
        TextView archived = button("已归档对话", colors.accent); archived.setTextSize(14);
        archived.setOnClickListener(v -> ConversationArchiveUi.showList(this, coordinator,
                archivedId -> {
                    try { coordinator.restoreConversation(archivedId); }
                    catch (RuntimeException e) { ConversationArchiveUi.toast(this, e); }
                },
                archivedId -> {
                    try {
                        coordinator.deleteConversation(archivedId);
                        if (archivedId.equals(id)) finish();
                    } catch (RuntimeException e) { ConversationArchiveUi.toast(this, e); }
                },
                this::openChat));
        footer.addView(archived, new LinearLayout.LayoutParams(-1, dp(48)));
        TextView home = button("回到桌面", colors.accent); home.setTextSize(14); home.setOnClickListener(v -> {
            startActivity(new Intent(this, MainActivity.class).setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)); finish();
        }); footer.addView(home, new LinearLayout.LayoutParams(-1, dp(48)));
    }
    private void archive() {
        try {
            coordinator.archiveConversation(id);
            startActivity(new Intent(this, MainActivity.class).putExtra(EXTRA_ARCHIVED_ID, id)
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP));
            finish();
        } catch (RuntimeException e) {
            Toast.makeText(this, e.getMessage(), Toast.LENGTH_LONG).show();
            refresh();
        }
    }
    private void confirmPermanentDelete() {
        if (currentCard != null && !"idle".equals(currentCard.optString("modelState"))) {
            Toast.makeText(this, "此会话正在运行，请先停止后再删除", Toast.LENGTH_SHORT).show();
            return;
        }
        new AlertDialog.Builder(this).setTitle("删除对话？")
                .setMessage("同时删除聊天历史与工作区；移除桌面小组件不会删除历史。")
                .setNegativeButton("取消", null).setPositiveButton("删除", (dialog, which) -> {
                    try { coordinator.deleteConversation(id); finish(); }
                    catch (RuntimeException e) { Toast.makeText(this, e.getMessage(), Toast.LENGTH_LONG).show(); refresh(); }
                }).show();
    }
    private void openChat(String conversationId) {
        startActivity(new Intent(this, MainActivity.class).putExtra(EXTRA_OPEN_CHAT, conversationId)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP));
        finish();
    }
    private void info(String key, String value) {
        LinearLayout row = row(); row.setMinimumHeight(dp(36));
        row.addView(label(key, 13, colors.muted), new LinearLayout.LayoutParams(0, -2, 1));
        row.addView(label(value, 13, colors.muted)); content.addView(row);
    }
    private void divider(int height, int margin) {
        View line = new View(this); line.setBackground(shape(colors.border, 4));
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, dp(height)); p.setMargins(0, dp(margin), 0, dp(margin)); content.addView(line, p);
    }
    private LinearLayout column() { LinearLayout view = new LinearLayout(this); view.setOrientation(LinearLayout.VERTICAL); return view; }
    private LinearLayout row() { LinearLayout view = new LinearLayout(this); view.setGravity(Gravity.CENTER_VERTICAL); return view; }
    private TextView label(String text, int size, int color) {
        TextView view = new TextView(this); view.setText(text); view.setTextSize(size); view.setTextColor(color); view.setIncludeFontPadding(false); return view;
    }
    private TextView button(String text, int color) {
        TextView view = label(text, 15, color); view.setGravity(Gravity.CENTER); view.setFocusable(true); view.setMinHeight(dp(48)); return view;
    }
    private GradientDrawable shape(int color, int radius) { GradientDrawable shape = new GradientDrawable(); shape.setColor(color); shape.setCornerRadius(dp(radius)); return shape; }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
