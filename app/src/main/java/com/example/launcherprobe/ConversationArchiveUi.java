package com.example.launcherprobe;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

/** Native archive list, remaining-time labels, undo bar, and restore prompt. */
final class ConversationArchiveUi {
    static final long RETENTION_MS = 14L * 24 * 60 * 60 * 1000;

    static long remainingMs(long archivedAt, long now) {
        return archivedAt <= 0 ? 0 : archivedAt + RETENTION_MS - now;
    }

    static String remainingLabel(Context context, long archivedAt, long now) {
        long left = remainingMs(archivedAt, now);
        if (left <= 0) return UiText.get(context, "即将清理");
        long day = 24L * 60 * 60 * 1000;
        long hour = 60L * 60 * 1000;
        long minute = 60L * 1000;
        if (left >= day) return UiText.get(context, "剩余 ") + (left / day) + UiText.get(context, " 天");
        if (left >= hour) return UiText.get(context, "剩余 ") + (left / hour) + UiText.get(context, " 小时");
        return UiText.get(context, "剩余 ") + Math.max(1, left / minute) + UiText.get(context, " 分钟");
    }

    static String archivedAtLabel(Context context, long archivedAt) {
        if (archivedAt <= 0) return UiText.get(context, "归档时间未知");
        CharSequence when = android.text.format.DateFormat.format(
                UiText.isEnglish(context) ? "MMM d, HH:mm" : "M月d日 HH:mm", archivedAt);
        return UiText.get(context, "归档于 ") + when;
    }

    static String retentionNotice(Context context) {
        return UiText.get(context, "归档对话会保留 14 天，到期后自动永久删除。再次归档会重新计时。");
    }

    static void showList(Activity activity, ChatCoordinator coordinator, Consumer<String> restore,
            Consumer<String> delete, Consumer<String> open) {
        LinearLayout content = new LinearLayout(activity);
        content.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(activity, 20);
        content.setPadding(pad, dp(activity, 8), pad, dp(activity, 8));
        AlertDialog dialog = new AlertDialog.Builder(activity)
                .setTitle(UiText.get(activity, "已归档对话"))
                .setView(content)
                .setNegativeButton(UiText.get(activity, "关闭"), null)
                .create();
        fillList(activity, coordinator, content, restore, delete, open, dialog);
        dialog.show();
    }

    private static void fillList(Activity activity, ChatCoordinator coordinator, LinearLayout content,
            Consumer<String> restore, Consumer<String> delete, Consumer<String> open, AlertDialog dialog) {
        content.removeAllViews();
        TextView notice = new TextView(activity);
        notice.setText(retentionNotice(activity));
        notice.setTextSize(13);
        notice.setTextColor(0xff656d69);
        notice.setPadding(0, 0, 0, dp(activity, 12));
        content.addView(notice);
        List<ChatStore.Conversation> items = new ArrayList<>(coordinator.store().archivedConversations());
        items.sort((left, right) -> Long.compare(right.archivedAt, left.archivedAt));
        if (items.isEmpty()) {
            TextView empty = new TextView(activity);
            empty.setText(UiText.get(activity, "没有已归档的对话"));
            empty.setTextSize(14);
            empty.setTextColor(0xff656d69);
            empty.setPadding(0, dp(activity, 16), 0, dp(activity, 16));
            content.addView(empty);
            return;
        }
        ScrollView scroll = new ScrollView(activity);
        LinearLayout list = new LinearLayout(activity);
        list.setOrientation(LinearLayout.VERTICAL);
        long now = System.currentTimeMillis();
        for (ChatStore.Conversation conversation : items) {
            list.addView(row(activity, conversation, now, id -> {
                restore.accept(id);
                fillList(activity, coordinator, content, restore, delete, open, dialog);
            }, id -> confirmPermanentDelete(activity, () -> {
                delete.accept(id);
                fillList(activity, coordinator, content, restore, delete, open, dialog);
            }), id -> {
                dialog.dismiss();
                open.accept(id);
            }));
        }
        scroll.addView(list);
        content.addView(scroll, new LinearLayout.LayoutParams(-1, Math.min(dp(activity, 420),
                activity.getResources().getDisplayMetrics().heightPixels / 2)));
    }

    private static LinearLayout row(Activity activity, ChatStore.Conversation conversation, long now,
            Consumer<String> restore, Consumer<String> delete, Consumer<String> open) {
        LinearLayout item = new LinearLayout(activity);
        item.setOrientation(LinearLayout.VERTICAL);
        item.setPadding(0, dp(activity, 10), 0, dp(activity, 10));
        TextView title = new TextView(activity);
        title.setText(conversation.title);
        title.setTextSize(16);
        title.setTextColor(0xff202521);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        title.setMaxLines(2);
        title.setEllipsize(TextUtils.TruncateAt.END);
        title.setMinHeight(dp(activity, 40));
        title.setGravity(Gravity.CENTER_VERTICAL);
        title.setFocusable(true);
        title.setOnClickListener(v -> open.accept(conversation.id));
        item.addView(title);
        TextView meta = new TextView(activity);
        meta.setText(archivedAtLabel(activity, conversation.archivedAt) + " · "
                + remainingLabel(activity, conversation.archivedAt, now));
        meta.setTextSize(12);
        meta.setTextColor(0xff656d69);
        meta.setPadding(0, dp(activity, 4), 0, dp(activity, 8));
        item.addView(meta);
        LinearLayout actions = new LinearLayout(activity);
        actions.setGravity(Gravity.CENTER_VERTICAL);
        TextView restoreButton = action(activity, UiText.get(activity, "恢复"), 0xff267a69,
                () -> restore.accept(conversation.id));
        actions.addView(restoreButton, new LinearLayout.LayoutParams(0, dp(activity, 44), 1));
        TextView deleteButton = action(activity, UiText.get(activity, "永久删除"), 0xffb3261e,
                () -> delete.accept(conversation.id));
        LinearLayout.LayoutParams deleteParams = new LinearLayout.LayoutParams(0, dp(activity, 44), 1);
        deleteParams.setMarginStart(dp(activity, 8));
        actions.addView(deleteButton, deleteParams);
        item.addView(actions);
        return item;
    }

    static void confirmPermanentDelete(Activity activity, Runnable confirmed) {
        new AlertDialog.Builder(activity)
                .setTitle(UiText.get(activity, "永久删除对话？"))
                .setMessage(UiText.get(activity, "删除后无法恢复。其他对话不会受影响。"))
                .setNegativeButton(UiText.get(activity, "取消"), null)
                .setPositiveButton(UiText.get(activity, "删除"), (dialog, which) -> confirmed.run())
                .show();
    }

    static void promptArchived(Activity activity, long archivedAt, Runnable restore, Runnable view) {
        long now = System.currentTimeMillis();
        String message = archivedAtLabel(activity, archivedAt) + " · "
                + remainingLabel(activity, archivedAt, now) + "\n" + retentionNotice(activity) + "\n"
                + UiText.get(activity, "发送前请先恢复此归档对话");
        AlertDialog.Builder builder = new AlertDialog.Builder(activity)
                .setTitle(UiText.get(activity, "此对话已归档"))
                .setMessage(message)
                .setPositiveButton(UiText.get(activity, "恢复"), (dialog, which) -> restore.run());
        if (view != null) builder.setNegativeButton(UiText.get(activity, "仅查看"),
                (dialog, which) -> view.run());
        else builder.setNegativeButton(UiText.get(activity, "取消"), null);
        builder.show();
    }

    static void showUndo(ViewGroup root, String message, Runnable undo, Context context) {
        View existing = root.findViewWithTag("archive-undo");
        if (existing != null) root.removeView(existing);
        LinearLayout bar = new LinearLayout(root.getContext());
        bar.setTag("archive-undo");
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(root, 16), dp(root, 10), dp(root, 12), dp(root, 10));
        GradientDrawable background = new GradientDrawable();
        background.setColor(0xf2242b27);
        background.setCornerRadius(dp(root, 16));
        bar.setBackground(background);
        TextView label = new TextView(root.getContext());
        label.setText(message);
        label.setTextSize(14);
        label.setTextColor(0xffe5eee9);
        bar.addView(label, new LinearLayout.LayoutParams(0, -2, 1));
        TextView action = new TextView(root.getContext());
        action.setText(UiText.get(context, "撤销"));
        action.setTextSize(14);
        action.setTextColor(0xff75c3af);
        action.setPadding(dp(root, 12), dp(root, 8), dp(root, 4), dp(root, 8));
        action.setMinHeight(dp(root, 40));
        action.setGravity(Gravity.CENTER);
        action.setFocusable(true);
        bar.addView(action, new LinearLayout.LayoutParams(-2, -2));
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM);
        int margin = dp(root, 16);
        params.setMargins(margin, margin, margin, margin);
        root.addView(bar, params);
        Runnable hide = () -> {
            if (bar.getParent() == root) root.removeView(bar);
        };
        bar.postDelayed(hide, 5000);
        action.setOnClickListener(v -> {
            bar.removeCallbacks(hide);
            hide.run();
            undo.run();
        });
        bar.addOnAttachStateChangeListener(new View.OnAttachStateChangeListener() {
            @Override public void onViewAttachedToWindow(View view) { }
            @Override public void onViewDetachedFromWindow(View view) { view.removeCallbacks(hide); }
        });
    }

    static void toast(Context context, Exception error) {
        Toast.makeText(context, error.getMessage() == null ? error.toString() : error.getMessage(),
                Toast.LENGTH_LONG).show();
    }

    private static TextView action(Context context, String text, int color, Runnable click) {
        TextView view = new TextView(context);
        view.setText(text);
        view.setTextSize(14);
        view.setTextColor(color);
        view.setGravity(Gravity.CENTER);
        view.setMinHeight(dp(context, 44));
        view.setFocusable(true);
        view.setOnClickListener(v -> click.run());
        return view;
    }

    private static int dp(View view, int value) {
        return Math.round(value * view.getResources().getDisplayMetrics().density);
    }

    private static int dp(Context context, int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
