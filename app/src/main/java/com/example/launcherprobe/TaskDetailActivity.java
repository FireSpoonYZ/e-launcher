package com.example.launcherprobe;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
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

/** Conversation details with an optional, directly rendered interactive virtual desktop. */
public final class TaskDetailActivity extends ComponentActivity {
    public static final String EXTRA_CONVERSATION_ID = "task_conversation_id";
    public static final String EXTRA_OPEN_CHAT = "task_open_chat";
    public static final String EXTRA_ARCHIVED_ID = "task_archived_id";
    private ChatCoordinator coordinator;
    private AppAppearance colors;
    private String id, signature = "";
    private LinearLayout content, footer, root, header, desktopPanel, navigation;
    private ScrollView detailsScroll;
    private TextView heading, desktopStatus, taskSummary, takeControl, expand;
    private ShowerDesktopView desktop;
    private boolean desktopAvailable, desktopLive, manualControl, fullscreen;
    private LinearLayout taskPane, taskProgress, questionHost;
    private View taskArea;
    private TextView subtitle;
    private HomeQuestionnaire.Draft questionDraft;
    private Bundle savedQuestionDraft;
    private AlertDialog desktopSheet;
    private String questionSignature = "", progressSignature = "";
    private TextView latestReply;
    private boolean replyExpanded;
    private boolean readingTask;
    private JSONObject currentCard;
    private final ChatCoordinator.Listener listener = (messages, event) -> refresh();

    @Override public void onCreate(Bundle state) {
        colors = AppAppearance.readWorkbench(this); colors.apply(this);
        super.onCreate(state); colors.applySystemBars(this, colors.background);
        coordinator = ChatCoordinator.get(this); id = getIntent().getStringExtra(EXTRA_CONVERSATION_ID);
        replyExpanded = state != null && state.getBoolean("reply_expanded");
        fullscreen = state != null && state.getBoolean("fullscreen");
        savedQuestionDraft = state == null ? null : state.getBundle("question_draft");
        root = column(); root.setBackgroundColor(colors.background);
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            androidx.core.graphics.Insets bars = androidx.core.view.WindowInsetsCompat.toWindowInsetsCompat(insets, view)
                    .getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars()
                            | androidx.core.view.WindowInsetsCompat.Type.displayCutout());
            view.setPadding(bars.left + dp(12), bars.top, bars.right + dp(12), bars.bottom); return insets;
        });
        header = row();
        TextView back = iconButton("previous", "返回", colors.ink);
        back.setOnClickListener(v -> finish());
        header.addView(back, new LinearLayout.LayoutParams(dp(48), dp(56)));
        LinearLayout titles = column();
        heading = label("任务详情", 19, colors.ink); heading.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        heading.setSingleLine(); heading.setEllipsize(android.text.TextUtils.TruncateAt.END); titles.addView(heading);
        subtitle = label("任务工作台", 12, colors.muted); subtitle.setPadding(0, dp(4), 0, 0); titles.addView(subtitle);
        header.addView(titles, new LinearLayout.LayoutParams(0, -2, 1));
        TextView more = iconButton("more", "更多任务操作", colors.ink);
        more.setOnClickListener(this::showMore); header.addView(more, new LinearLayout.LayoutParams(dp(48), dp(48)));
        root.addView(header, new LinearLayout.LayoutParams(-1, dp(64)));
        boolean landscape = getResources().getConfiguration().orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE;
        LinearLayout workspace = column(); workspace.setBaselineAligned(false);
        workspace.setOrientation(landscape ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL);
        root.addView(workspace, new LinearLayout.LayoutParams(-1, 0, 1));
        desktopPanel = column(); desktopPanel.setVisibility(View.GONE);
        desktopPanel.setBackground(outline(colors.surface, 18)); desktopPanel.setClipToOutline(true);
        LinearLayout displayBar = row(); displayBar.setPadding(dp(14), 0, dp(4), 0);
        TextView displayTitle = label("虚拟桌面", 15, colors.ink); displayTitle.setTypeface(Typeface.DEFAULT_BOLD);
        displayBar.addView(displayTitle);
        desktopStatus = label("连接中", 12, colors.muted); desktopStatus.setPadding(dp(10), 0, 0, 0);
        desktopStatus.setSingleLine(); desktopStatus.setEllipsize(android.text.TextUtils.TruncateAt.END);
        desktopStatus.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        displayBar.addView(desktopStatus, new LinearLayout.LayoutParams(0, -2, 1));
        expand = button("放大", colors.ink); expand.setTextSize(13); decorate(expand, "expand", colors.ink);
        expand.setContentDescription("全屏显示虚拟桌面");
        expand.setOnClickListener(v -> setFullscreen(!fullscreen));
        displayBar.addView(expand, new LinearLayout.LayoutParams(dp(96), dp(48)));
        desktopPanel.addView(displayBar, new LinearLayout.LayoutParams(-1, dp(48)));
        desktop = new ShowerDesktopView(this, colors, () -> PiAgentBridge.existingDesktop(id), this::desktopChanged);
        desktop.setBackgroundColor(colors.panel); desktop.setPadding(dp(6), dp(6), dp(6), dp(6));
        desktopPanel.addView(desktop, new LinearLayout.LayoutParams(-1, 0, 1));
        navigation = row(); navigation.setPadding(dp(4), dp(2), dp(4), dp(2));
        navigationKey("arrow-left", "返回", "虚拟桌面返回", android.view.KeyEvent.KEYCODE_BACK);
        navigationApps("apps", "应用", "虚拟桌面应用列表", false);
        navigationApps("copy", "最近", "虚拟桌面最近打开的应用", true);
        TextView keyboard = navigationButton("keyboard", "输入", "向虚拟桌面输入文字");
        keyboard.setOnClickListener(v -> showKeyboard()); navigation.addView(keyboard, new LinearLayout.LayoutParams(0, dp(56), 1));
        desktopPanel.addView(navigation, new LinearLayout.LayoutParams(-1, dp(60)));
        workspace.addView(desktopPanel, new LinearLayout.LayoutParams(landscape ? 0 : -1, landscape ? -1 : 0, 1));
        detailsScroll = new ScrollView(this); detailsScroll.setVerticalScrollBarEnabled(false);
        content = column(); content.setPadding(dp(8), dp(10), dp(8), dp(8)); detailsScroll.addView(content);
        workspace.addView(detailsScroll, new LinearLayout.LayoutParams(landscape ? 0 : -1, landscape ? -1 : 0, 1));
        taskPane = column(); taskPane.setVisibility(View.GONE); taskPane.setPadding(dp(14), dp(12), dp(14), dp(12));
        taskPane.setBackground(outline(colors.surface, 18));
        taskProgress = column(); taskPane.addView(taskProgress);
        questionHost = column(); taskPane.addView(questionHost, new LinearLayout.LayoutParams(-1, 0, 1));
        LinearLayout.LayoutParams taskParams = new LinearLayout.LayoutParams(landscape ? 0 : -1, landscape ? -1 : 0, landscape ? 1 : 1.12f);
        if (landscape) taskParams.leftMargin = dp(10); else taskParams.topMargin = dp(10);
        taskArea = taskPane;
        if (landscape) {
            ScrollView taskScroll = new ScrollView(this); taskScroll.setFillViewport(true); taskScroll.setVerticalScrollBarEnabled(false);
            taskScroll.addView(taskPane, new android.widget.FrameLayout.LayoutParams(-1, dp(380)));
            taskArea = taskScroll;
        }
        taskArea.setVisibility(View.GONE); workspace.addView(taskArea, taskParams);
        taskSummary = button("任务进度", colors.ink); taskSummary.setGravity(Gravity.CENTER_VERTICAL);
        taskSummary.setPadding(dp(14), 0, dp(14), 0); taskSummary.setSingleLine(false); taskSummary.setMaxLines(2); taskSummary.setTextSize(14);
        taskSummary.setEllipsize(android.text.TextUtils.TruncateAt.END); taskSummary.setBackground(outline(colors.surface, 14));
        ChatIcon up = new ChatIcon("up", colors.muted); up.setBounds(0, 0, dp(20), dp(20));
        ChatIcon bubble = new ChatIcon("bubble", colors.ink); bubble.setBounds(0, 0, dp(22), dp(22));
        taskSummary.setCompoundDrawablesRelative(bubble, null, up, null); taskSummary.setCompoundDrawablePadding(dp(12));
        taskSummary.setContentDescription("展开任务进度和提问回答"); taskSummary.setVisibility(View.GONE);
        taskSummary.setOnClickListener(v -> setFullscreen(false));
        LinearLayout.LayoutParams summaryParams = new LinearLayout.LayoutParams(-1, dp(56)); summaryParams.topMargin = dp(8);
        root.addView(taskSummary, summaryParams);
        footer = column(); footer.setPadding(0, dp(10), 0, dp(8)); root.addView(footer);
        setContentView(root); root.requestApplyInsets(); refresh();
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { back(); }
        });
    }
    @Override public void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state); state.putBoolean("reply_expanded", replyExpanded); state.putBoolean("fullscreen", fullscreen);
        if (questionDraft != null) state.putBundle("question_draft", questionDraft.save());
    }
    @Override protected void onStart() { super.onStart(); coordinator.addListener(listener); refresh(); desktop.start(); }
    @Override protected void onResume() {
        super.onResume();
        readingTask = true;
        if (hasWindowFocus()) coordinator.markTaskRead(id);
        TaskNotifications.requestPermission(this);
        new Thread(() -> {
            try { coordinator.purgeExpiredArchives(); }
            catch (RuntimeException ignored) { }
            if (isFinishing()) return;
            runOnUiThread(() -> { if (!isFinishing()) refresh(); });
        }, "archive-purge").start();
    }
    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused && readingTask) coordinator.markTaskRead(id);
    }
    @Override protected void onPause() { readingTask = false; super.onPause(); }
    @Override protected void onStop() { desktop.stop(); coordinator.removeListener(listener); super.onStop(); }
    @Override protected void onDestroy() { desktop.dispose(); if (desktopSheet != null) desktopSheet.dismiss(); super.onDestroy(); }
    private void back() { if (fullscreen) setFullscreen(false); else finish(); }

    private void refresh() {
        JSONObject card = id == null ? null : coordinator.taskCard(id);
        if (card == null) { finish(); return; }
        if (readingTask && hasWindowFocus()) coordinator.markTaskRead(id);
        currentCard = card;
        if (latestReply != null && replyExpanded) latestReply.setText(card.optString("result"));
        renderTaskPane(card);
        String model = card.optString("modelState");
        String next = String.join("|", card.optString("title"), model, card.optString("runStatus"),
                String.valueOf(card.opt("todo")), card.optString("error"), String.valueOf(card.optString("result").isEmpty()),
                String.valueOf(desktopAvailable), String.valueOf(desktopLive), String.valueOf(manualControl), HomeTaskCards.status(card));
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
                step.addView(new TaskStepMarker(this, status, model, colors.accent), new LinearLayout.LayoutParams(dp(30), dp(32)));
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
        heading.setText(desktopAvailable ? card.optString("title") : "任务详情");
        long completedCount = tasks.stream().filter(t -> "completed".equals(t.optString("status"))).count();
        String currentStep = tasks.stream().filter(t -> "in_progress".equals(t.optString("status")))
                .map(t -> t.optString("subject")).findFirst().orElse(HomeTaskCards.status(card));
        String summaryTitle = HomeQuestionnaire.liveQuestion(card) != null ? "需要你回答" : currentStep;
        String summaryDetail = tasks.isEmpty() ? "查看任务动态" : "任务进度 " + completedCount + " / " + tasks.size();
        android.text.SpannableString summaryText = new android.text.SpannableString(summaryTitle + "\n" + summaryDetail);
        summaryText.setSpan(new android.text.style.ForegroundColorSpan(colors.muted), summaryTitle.length() + 1, summaryText.length(), 0);
        summaryText.setSpan(new android.text.style.RelativeSizeSpan(.85f), summaryTitle.length() + 1, summaryText.length(), 0);
        taskSummary.setText(summaryText);
        if (desktopAvailable) {
            LinearLayout actions = row();
            TextView chat = button("查看对话", colors.ink); decorate(chat, "bubble", colors.ink);
            chat.setBackground(surface(colors.surface, colors.border, 14));
            chat.setOnClickListener(v -> openChat(id)); actions.addView(chat, new LinearLayout.LayoutParams(0, dp(48), 1));
            takeControl = button(manualControl ? "结束接管" : "接管操作", colors.dark ? colors.background : 0xffffffff);
            decorate(takeControl, "gesture", colors.dark ? colors.background : 0xffffffff);
            takeControl.setBackground(surface(colors.accent, 0, 14)); takeControl.setEnabled(desktopLive); takeControl.setAlpha(desktopLive ? 1f : .45f);
            takeControl.setOnClickListener(v -> desktop.toggleControl());
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(48), 1); params.leftMargin = dp(10);
            actions.addView(takeControl, params); footer.addView(actions);
            return;
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
    private void renderTaskPane(JSONObject card) {
        List<JSONObject> tasks = HomeTaskCards.tasks(card);
        long completed = tasks.stream().filter(t -> "completed".equals(t.optString("status"))).count();
        String progressKey = String.valueOf(card.opt("todo")) + card.optString("modelState");
        if (!progressKey.equals(progressSignature)) {
            progressSignature = progressKey; taskProgress.removeAllViews();
            LinearLayout title = row();
            TextView name = label("任务进度", 16, colors.ink); name.setTypeface(Typeface.DEFAULT_BOLD); name.setAccessibilityHeading(true);
            title.addView(name, new LinearLayout.LayoutParams(0, -2, 1));
            title.addView(label(tasks.isEmpty() ? "暂无步骤" : completed + " / " + tasks.size(), 13, colors.muted));
            taskProgress.addView(title);
            if (!tasks.isEmpty()) {
                ProgressBar progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
                ScaleDrawable fill = new ScaleDrawable(shape(colors.accent, 3), Gravity.LEFT, 1f, -1f);
                LayerDrawable track = new LayerDrawable(new android.graphics.drawable.Drawable[]{shape(colors.panel, 3), fill});
                track.setId(0, android.R.id.background); track.setId(1, android.R.id.progress);
                progress.setProgressDrawable(track); progress.setMax(tasks.size()); progress.setProgress((int) completed);
                progress.setContentDescription("已完成 " + completed + " 项，共 " + tasks.size() + " 项");
                LinearLayout.LayoutParams bar = new LinearLayout.LayoutParams(-1, dp(4)); bar.setMargins(0, dp(10), 0, dp(8));
                taskProgress.addView(progress, bar);
                TaskProgressStrip strip = new TaskProgressStrip(this, colors, tasks, card.optString("modelState"));
                taskProgress.addView(strip);
                int active = -1;
                for (int i = 0; i < tasks.size(); i++) if ("in_progress".equals(tasks.get(i).optString("status"))) { active = i; break; }
                final int selected = active;
                strip.post(() -> {
                    if (selected < 0) return;
                    View node = ((LinearLayout) strip.getChildAt(0)).getChildAt(selected);
                    strip.scrollTo(Math.max(0, node.getLeft() + node.getWidth() / 2 - strip.getWidth() / 2), 0);
                });
            }
            View separator = new View(this); separator.setBackgroundColor(colors.border);
            LinearLayout.LayoutParams line = new LinearLayout.LayoutParams(-1, dp(1)); line.setMargins(0, dp(10), 0, dp(10));
            taskProgress.addView(separator, line);
        }
        JSONObject question = HomeQuestionnaire.liveQuestion(card);
        if (questionDraft != null && !questionDraft.matches(card)) questionDraft = null;
        String next = question == null ? "reply:" + card.optString("result") + HomeTaskCards.status(card)
                : card.optString("requestId") + question + card.optBoolean("questionnairePending") + card.optString("questionnaireError");
        if (next.equals(questionSignature)) return;
        questionSignature = next; questionHost.removeAllViews();
        if (question != null) {
            if (questionDraft == null) {
                questionDraft = new HomeQuestionnaire.Draft(card);
                questionDraft.restore(savedQuestionDraft); savedQuestionDraft = null;
            }
            TextView caption = label("需要你回答", 12, colors.accent); decorate(caption, "question-bubble", colors.accent);
            caption.setPadding(0, 0, 0, dp(8)); caption.setGravity(Gravity.CENTER_VERTICAL);
            caption.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); questionHost.addView(caption);
            questionHost.addView(new HomeQuestionnaire(this, card, questionDraft,
                    (conversationId, requestId, questionnaireId, answers, cancelled) -> {
                        if (cancelled) coordinator.cancelQuestionnaire(conversationId, requestId, questionnaireId);
                        else coordinator.submitQuestionnaire(conversationId, requestId, questionnaireId, answers, null);
                    }, colors), new LinearLayout.LayoutParams(-1, 0, 1));
        } else {
            ScrollView scroll = new ScrollView(this); scroll.setVerticalScrollBarEnabled(false);
            LinearLayout body = column();
            TextView state = label(HomeTaskCards.status(card), 12, colors.accent); state.setPadding(0, 0, 0, dp(10)); body.addView(state);
            TextView reply = label(card.optString("result").isEmpty() ? "任务动态会显示在这里；需要回答时可直接在下方回复。" : card.optString("result"), 14, colors.ink);
            reply.setTextIsSelectable(true); reply.setLineSpacing(dp(3), 1f); body.addView(reply);
            scroll.addView(body); questionHost.addView(scroll, new LinearLayout.LayoutParams(-1, -1));
        }
    }

    private void desktopChanged(boolean available, boolean live, boolean manual, String status) {
        desktopAvailable = available; desktopLive = live; manualControl = manual;
        desktopStatus.setText(live ? (manual ? "手动操作" : "实时") : status.contains("结束") ? "已结束" : "连接中");
        desktopStatus.setTextColor(live ? colors.accent : colors.muted);
        GradientDrawable signal = shape(live ? colors.accent : colors.muted, 6); signal.setBounds(0, 0, dp(6), dp(6));
        desktopStatus.setCompoundDrawablesRelative(signal, null, null, null); desktopStatus.setCompoundDrawablePadding(dp(6));
        desktopStatus.setContentDescription(status);
        for (int i = 0; i < navigation.getChildCount(); i++) {
            navigation.getChildAt(i).setEnabled(manual && live);
            navigation.getChildAt(i).setAlpha(manual && live ? 1f : .45f);
        }
        applyDesktopLayout();
        refresh();
    }

    private void setFullscreen(boolean value) {
        fullscreen = value && desktopAvailable;
        applyDesktopLayout();
    }

    private void applyDesktopLayout() {
        boolean expanded = fullscreen && desktopAvailable;
        expand.setText(expanded ? "收起" : "放大");
        decorate(expand, expanded ? "collapse" : "expand", colors.ink);
        expand.setContentDescription(expanded ? "退出全屏" : "全屏显示虚拟桌面");
        desktopPanel.setVisibility(desktopAvailable ? View.VISIBLE : View.GONE);
        detailsScroll.setVisibility(desktopAvailable ? View.GONE : View.VISIBLE);
        header.setVisibility(expanded ? View.GONE : View.VISIBLE);
        taskPane.setVisibility(desktopAvailable && !expanded ? View.VISIBLE : View.GONE);
        taskArea.setVisibility(taskPane.getVisibility());
        taskSummary.setVisibility(expanded ? View.VISIBLE : View.GONE);
        footer.setVisibility(View.VISIBLE);
    }

    private void navigationKey(String icon, String title, String description, int key) {
        TextView control = navigationButton(icon, title, description);
        control.setOnClickListener(v -> desktop.key(key)); navigation.addView(control, new LinearLayout.LayoutParams(0, dp(56), 1));
    }

    // Android's global HOME/RECENTS can affect the physical screen on secondary displays.
    // Display-scoped app pickers provide navigation without invoking those global actions.
    private void navigationApps(String icon, String title, String description, boolean recent) {
        TextView control = navigationButton(icon, title, description);
        control.setOnClickListener(v -> desktop.applications(recent, apps -> {
            if (isFinishing() || isDestroyed() || !desktop.isManual()) return;
            if (apps.isEmpty()) {
                Toast.makeText(this, recent ? "此桌面还没有打开过应用" : "没有可启动的应用", Toast.LENGTH_SHORT).show();
                return;
            }
            LinearLayout list = column();
            apps.forEach((packageName, name) -> {
                LinearLayout item = row(); item.setPadding(dp(8), dp(8), dp(8), dp(8));
                item.setBackground(surface(colors.surface, 0, 12)); item.setFocusable(true); item.setContentDescription("打开 " + name);
                ImageView image = new ImageView(this);
                try { image.setImageDrawable(getPackageManager().getApplicationIcon(packageName)); }
                catch (android.content.pm.PackageManager.NameNotFoundException ignored) { image.setImageDrawable(new ChatIcon("apps", colors.muted)); }
                item.addView(image, new LinearLayout.LayoutParams(dp(32), dp(32)));
                TextView label = label(name, 15, colors.ink); label.setPadding(dp(14), 0, 0, 0);
                item.addView(label, new LinearLayout.LayoutParams(0, -2, 1));
                item.setOnClickListener(clicked -> { desktop.launch(packageName); desktopSheet.dismiss(); });
                list.addView(item, new LinearLayout.LayoutParams(-1, dp(56)));
            });
            ScrollView scroll = new ScrollView(this); scroll.setVerticalScrollBarEnabled(false); scroll.addView(list);
            LinearLayout body = column(); body.addView(scroll, new LinearLayout.LayoutParams(-1,
                    Math.min(dp(56) * apps.size(), getResources().getDisplayMetrics().heightPixels / 2)));
            showDesktopSheet(recent ? "最近应用" : "打开应用", body);
        }));
        navigation.addView(control, new LinearLayout.LayoutParams(0, dp(56), 1));
    }

    private void showKeyboard() {
        if (!desktop.isManual()) return;
        android.widget.EditText input = new android.widget.EditText(this);
        input.setHint("替换虚拟桌面当前输入框的文字"); input.setTextSize(16);
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        input.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(1000)});
        input.setMinLines(2); input.setMaxLines(6); input.setTextColor(colors.ink); input.setHintTextColor(colors.muted);
        input.setPadding(dp(14), dp(12), dp(14), dp(12)); input.setBackground(outline(colors.panel, 12));
        LinearLayout body = column(); body.addView(input, new LinearLayout.LayoutParams(-1, -2));
        LinearLayout keys = row();
        for (int code : new int[]{android.view.KeyEvent.KEYCODE_DEL, android.view.KeyEvent.KEYCODE_ENTER}) {
            TextView key = button(code == android.view.KeyEvent.KEYCODE_DEL ? "退格" : "回车", colors.accent);
            key.setOnClickListener(v -> desktop.key(code)); keys.addView(key, new LinearLayout.LayoutParams(0, dp(48), 1));
        }
        body.addView(keys);
        TextView send = button("替换输入", colors.dark ? colors.background : 0xffffffff);
        send.setBackground(surface(colors.accent, 0, 12));
        send.setOnClickListener(v -> { desktop.text(input.getText().toString()); desktopSheet.dismiss(); });
        body.addView(send, new LinearLayout.LayoutParams(-1, dp(48)));
        showDesktopSheet("输入到虚拟桌面", body);
        input.requestFocus();
        desktopSheet.getWindow().setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE
                | android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
    }

    private void showDesktopSheet(String title, LinearLayout body) {
        if (desktopSheet != null) desktopSheet.dismiss();
        LinearLayout sheet = column(); sheet.setPadding(dp(16), dp(8), dp(16), dp(16));
        sheet.setBackground(outline(colors.surface, 22));
        LinearLayout bar = row(); TextView name = label(title, 18, colors.ink); name.setTypeface(Typeface.DEFAULT_BOLD);
        bar.addView(name, new LinearLayout.LayoutParams(0, -2, 1));
        TextView close = iconButton("close", "关闭", colors.muted); close.setOnClickListener(v -> desktopSheet.dismiss());
        bar.addView(close, new LinearLayout.LayoutParams(dp(48), dp(48)));
        sheet.addView(bar); sheet.addView(body);
        desktopSheet = new AlertDialog.Builder(this).setView(sheet).create();
        desktopSheet.show();
        android.view.Window window = desktopSheet.getWindow();
        window.setBackgroundDrawableResource(android.R.color.transparent);
        window.setDimAmount(.25f); window.setGravity(Gravity.BOTTOM);
        window.setLayout(getResources().getDisplayMetrics().widthPixels - dp(24), -2);
    }

    private void showMore(View anchor) {
        android.widget.PopupMenu menu = new android.widget.PopupMenu(this, anchor);
        if (currentCard != null && !"idle".equals(currentCard.optString("modelState"))) menu.getMenu().add("停止任务");
        for (String name : new String[]{"归档", "永久删除", "已归档对话", "回到桌面"}) menu.getMenu().add(name);
        menu.setOnMenuItemClickListener(item -> {
            switch (item.getTitle().toString()) {
                case "停止任务" -> { coordinator.cancel(id); refresh(); }
                case "归档" -> archive();
                case "永久删除" -> confirmPermanentDelete();
                case "已归档对话" -> ConversationArchiveUi.showList(this, coordinator,
                        archivedId -> { try { coordinator.restoreConversation(archivedId); } catch (RuntimeException e) { ConversationArchiveUi.toast(this, e); } },
                        archivedId -> { try { coordinator.deleteConversation(archivedId); if (archivedId.equals(id)) finish(); } catch (RuntimeException e) { ConversationArchiveUi.toast(this, e); } }, this::openChat);
                case "回到桌面" -> {
                    startActivity(new Intent(this, MainActivity.class).setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
                            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)); finish();
                }
                default -> { return false; }
            }
            return true;
        });
        menu.show();
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
    private LinearLayout row() { LinearLayout view = new LinearLayout(this); view.setGravity(Gravity.CENTER_VERTICAL); view.setBaselineAligned(false); return view; }
    private TextView label(String text, int size, int color) {
        TextView view = new TextView(this); view.setText(text); view.setTextSize(size); view.setTextColor(color); view.setIncludeFontPadding(false); return view;
    }
    private TextView button(String text, int color) {
        TextView view = label(text, 15, color); view.setGravity(Gravity.CENTER); view.setFocusable(true); view.setMinHeight(dp(48));
        view.setSingleLine(); view.setEllipsize(android.text.TextUtils.TruncateAt.END);
        view.setBackground(surface(android.graphics.Color.TRANSPARENT, 0, 12));
        view.setAccessibilityDelegate(new View.AccessibilityDelegate() {
            @Override public void onInitializeAccessibilityNodeInfo(View host, android.view.accessibility.AccessibilityNodeInfo info) {
                super.onInitializeAccessibilityNodeInfo(host, info); info.setClassName("android.widget.Button");
            }
        });
        Motion.press(view); return view;
    }
    private TextView iconButton(String icon, String description, int color) {
        TextView view = button("", color); view.setPadding(dp(13), 0, dp(13), 0);
        decorate(view, icon, color); view.setContentDescription(description); return view;
    }
    private TextView navigationButton(String icon, String title, String description) {
        TextView view = button(title, colors.ink); view.setTextSize(11); view.setContentDescription(description);
        ChatIcon drawable = new ChatIcon(icon, colors.ink); drawable.setBounds(0, 0, dp(22), dp(22));
        view.setCompoundDrawablesRelative(null, drawable, null, null); view.setCompoundDrawablePadding(dp(3));
        view.setPadding(0, dp(5), 0, dp(5)); return view;
    }
    private void decorate(TextView view, String icon, int color) {
        ChatIcon drawable = new ChatIcon(icon, color); drawable.setBounds(0, 0, dp(20), dp(20));
        view.setCompoundDrawablesRelative(drawable, null, null, null); view.setCompoundDrawablePadding(dp(8));
        if (!view.getText().toString().isEmpty()) view.setPadding(dp(14), 0, dp(14), 0);
    }
    private GradientDrawable outline(int color, int radius) {
        GradientDrawable result = shape(color, radius); result.setStroke(dp(1), colors.border); return result;
    }
    private android.graphics.drawable.Drawable surface(int color, int border, int radius) {
        GradientDrawable result = shape(color, radius); if (border != 0) result.setStroke(dp(1), border);
        return new android.graphics.drawable.RippleDrawable(android.content.res.ColorStateList.valueOf(colors.dark ? 0x3370d4df : 0x18087f8c), result, null);
    }
    private GradientDrawable shape(int color, int radius) { GradientDrawable shape = new GradientDrawable(); shape.setColor(color); shape.setCornerRadius(dp(radius)); return shape; }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
