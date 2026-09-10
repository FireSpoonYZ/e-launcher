package com.example.launcherprobe;

import android.app.Dialog;
import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.function.Consumer;

/** Modal native bottom sheet: selection previews; only the explicit action navigates. */
final class ConversationTreeSheet extends Dialog {
    private static final int INK = 0xFF202824, MUTED = 0xFF6D7773;
    private final ConversationTree tree;
    private final Consumer<ConversationTree.Node> navigate;
    private final Set<String> folded = new HashSet<>();
    private String selected, query = "";
    private LinearLayout panel;
    private TreeRows rows;
    private ScrollView scroll;
    private TextView preview, action;
    private float dragStart;

    ConversationTreeSheet(Context context, ConversationTree tree, Consumer<ConversationTree.Node> navigate) {
        super(context);
        this.tree = tree;
        this.navigate = navigate;
        selected = tree.leaf();
    }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        panel = column();
        panel.setPadding(dp(14), dp(4), dp(14), dp(14));
        panel.setBackground(background(Color.WHITE, 26));
        TextView handle = text("━━", 20, 0xFFABB0AD);
        handle.setGravity(Gravity.CENTER);
        handle.setContentDescription("向下拖动关闭对话树");
        panel.addView(handle, new LinearLayout.LayoutParams(-1, dp(36)));
        handle.setOnTouchListener((view, event) -> {
            if (event.getActionMasked() == MotionEvent.ACTION_DOWN) { dragStart = event.getRawY(); return true; }
            if (event.getActionMasked() == MotionEvent.ACTION_MOVE) {
                panel.setTranslationY(Math.max(0, event.getRawY() - dragStart)); return true;
            }
            if (event.getActionMasked() == MotionEvent.ACTION_UP || event.getActionMasked() == MotionEvent.ACTION_CANCEL) {
                if (event.getActionMasked() == MotionEvent.ACTION_UP && panel.getTranslationY() > dp(72)) dismiss();
                else panel.animate().translationY(0).setDuration(160).start();
                view.performClick(); return true;
            }
            return false;
        });
        LinearLayout header = row();
        TextView title = text("对话树", 21, INK);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        header.addView(title, new LinearLayout.LayoutParams(0, dp(48), 1));
        TextView locate = button("定位当前", () -> {
            selected = tree.leaf(); query = "";
            for (ConversationTree.Node n = tree.node(selected); n != null; n = tree.node(n.parentId)) folded.remove(n.id);
            EditText search = panel.findViewWithTag("tree-search");
            search.setText(""); render(); scrollToSelected();
        });
        header.addView(locate);
        header.addView(button("×", this::dismiss));
        panel.addView(header);
        EditText search = new EditText(getContext());
        search.setTag("tree-search"); search.setSingleLine(true);
        search.setTextSize(14); search.setHint("搜索历史消息");
        search.setContentDescription("搜索历史消息");
        search.setPadding(dp(14), 0, dp(14), 0);
        search.setBackground(background(0xFFF5F6F5, 18));
        panel.addView(search, new LinearLayout.LayoutParams(-1, dp(44)));
        scroll = new ScrollView(getContext()); scroll.setFillViewport(true);
        rows = new TreeRows(getContext()); rows.setPadding(0, dp(10), 0, dp(10));
        scroll.addView(rows);
        panel.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        View divider = new View(getContext()); divider.setBackgroundColor(0xFFE1E5E2);
        panel.addView(divider, new LinearLayout.LayoutParams(-1, dp(1)));
        preview = text("", 14, INK);
        preview.setMaxLines(4);
        preview.setEllipsize(android.text.TextUtils.TruncateAt.END);
        preview.setPadding(0, dp(12), 0, dp(12));
        panel.addView(preview, new LinearLayout.LayoutParams(-1, -2));
        LinearLayout footer = row();
        footer.setGravity(Gravity.RIGHT | Gravity.CENTER_VERTICAL);
        footer.addView(button("取消", this::dismiss));
        action = button("从此处继续", () -> {
            ConversationTree.Node node = tree.node(selected);
            if (node != null) navigate.accept(node);
        });
        action.setTextColor(Color.WHITE); action.setBackground(background(INK, 24));
        footer.addView(action); panel.addView(footer);
        LinearLayout outer = column(); outer.setPadding(dp(10), 0, dp(10), dp(10));
        outer.addView(panel, new LinearLayout.LayoutParams(-1, -1));
        setContentView(outer);
        setCanceledOnTouchOutside(true);
        Window window = getWindow();
        window.setBackgroundDrawableResource(android.R.color.transparent);
        window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
        window.setDimAmount(.28f); window.setGravity(Gravity.BOTTOM);
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
                | WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN);
        window.setWindowAnimations(android.R.style.Animation_InputMethod);
        window.setLayout(-1, (int) (getContext().getResources().getDisplayMetrics().heightPixels * .78f));
        search.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            public void onTextChanged(CharSequence s, int start, int before, int count) {
                query = s.toString().trim().toLowerCase(Locale.ROOT); render();
            }
            public void afterTextChanged(Editable s) { }
        });
        render(); scrollToSelected();
    }

    private void render() {
        int top = scroll.getScrollY();
        rows.clearTree();
        Set<String> matches = new HashSet<>();
        if (!query.isEmpty()) for (ConversationTree.Node n : tree.nodes()) {
            if (summary(n).toLowerCase(Locale.ROOT).contains(query)) {
                for (ConversationTree.Node ancestor = n; ancestor != null; ancestor = tree.node(ancestor.parentId))
                    matches.add(ancestor.id);
            }
        }
        List<ConversationTree.Row> visible = tree.rows(query.isEmpty() ? folded : Collections.emptySet());
        for (ConversationTree.Row entry : visible) {
            ConversationTree.Node node = entry.node;
            if (!query.isEmpty() && !matches.contains(node.id)) continue;
            LinearLayout line = row(); line.setTag(node.id);
            int availableDp = (int) (getContext().getResources().getDisplayMetrics().widthPixels
                    / getContext().getResources().getDisplayMetrics().density);
            line.setOnClickListener(v -> { selected = node.id; render(); });
            View rail = new View(getContext());
            line.addView(rail, new LinearLayout.LayoutParams(
                    dp(Math.min(entry.depth * 16, Math.max(0, availableDp - 280)) + 14), dp(48)));
            TextView snippet = text(role(node.message) + "  " + summary(node), 14, INK);
            snippet.setSingleLine(true); snippet.setEllipsize(android.text.TextUtils.TruncateAt.END);
            snippet.setContentDescription("分支深度 " + entry.depth + "，" + role(node.message) + "，" + summary(node));
            snippet.setOnClickListener(v -> { selected = node.id; render(); });
            line.addView(snippet, new LinearLayout.LayoutParams(0, dp(48), 1));
            if (node.id.equals(tree.leaf())) line.addView(text("当前", 11, 0xFF47685F));
            if (entry.descendants > 0) {
                boolean closed = folded.contains(node.id) && query.isEmpty();
                TextView fold = button(closed ? "› " + entry.descendants : "⌄", () -> {
                    if (!folded.remove(node.id)) folded.add(node.id);
                    render();
                });
                fold.setContentDescription((closed ? "展开" : "折叠") + "后续 " + entry.descendants + " 条消息");
                line.addView(fold);
            }
            if (node.id.equals(selected)) line.setBackground(background(0xFFE7EFEB, 12));
            rows.addTreeRow(entry, line);
        }
        if (rows.getChildCount() == 0) rows.addView(text(query.isEmpty() ? "发送消息后，这里会显示对话历史" : "没有匹配的消息", 14, MUTED));
        ConversationTree.Node picked = tree.node(selected);
        preview.setText(picked == null ? "选择一个节点预览" : "预览 · " + role(picked.message) + "\n" + summary(picked));
        action.setEnabled(picked != null); action.setAlpha(picked == null ? .4f : 1f);
        action.setText(picked != null && "user".equals(picked.message.role) ? "编辑并继续" : "从此处继续");
        scroll.post(() -> scroll.scrollTo(0, top));
    }

    /** Draw real parent links across rows, including the rail spanning sibling subtrees. */
    private static final class TreeRows extends LinearLayout {
        private final java.util.Map<String, TreeLine> lines = new java.util.LinkedHashMap<>();
        private final android.graphics.Paint paint = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
        private final float density;

        private static final class TreeLine {
            final ConversationTree.Row row;
            final LinearLayout view;
            TreeLine(ConversationTree.Row row, LinearLayout view) { this.row = row; this.view = view; }
        }

        TreeRows(Context context) {
            super(context);
            density = getResources().getDisplayMetrics().density;
            setOrientation(VERTICAL);
            paint.setStrokeWidth(1.2f * density);
            paint.setStrokeCap(android.graphics.Paint.Cap.ROUND);
            paint.setStrokeJoin(android.graphics.Paint.Join.ROUND);
        }

        void clearTree() { lines.clear(); removeAllViews(); }
        void addTreeRow(ConversationTree.Row row, LinearLayout view) {
            lines.put(row.node.id, new TreeLine(row, view));
            addView(view, new LayoutParams(-1, -2));
        }
        private float x(TreeLine line) { return line.view.getChildAt(0).getWidth() - 7 * density; }
        private float y(TreeLine line) { return line.view.getTop() + line.view.getHeight() / 2f; }

        @Override protected void dispatchDraw(android.graphics.Canvas canvas) {
            super.dispatchDraw(canvas);
            paint.setStyle(android.graphics.Paint.Style.STROKE);
            // Current-path edges are drawn last so shared rails retain their emphasis.
            for (boolean current : new boolean[]{false, true}) {
                paint.setColor(current ? 0xFF54766B : 0xFFC3CCC7);
                for (TreeLine child : lines.values()) {
                    TreeLine parent = lines.get(child.row.node.parentId);
                    if (parent == null || child.row.currentPath != current) continue;
                    android.graphics.Path path = new android.graphics.Path();
                    path.moveTo(x(parent), y(parent));
                    path.lineTo(x(parent), y(child));
                    path.lineTo(x(child), y(child));
                    canvas.drawPath(path, paint);
                }
            }
            paint.setStyle(android.graphics.Paint.Style.FILL);
            for (TreeLine line : lines.values()) {
                paint.setColor(line.row.currentPath ? 0xFF54766B : 0xFFC3CCC7);
                canvas.drawCircle(x(line), y(line), 2.3f * density, paint);
            }
        }
    }

    private void scrollToSelected() {
        rows.post(() -> {
            View view = selected == null ? null : rows.findViewWithTag(selected);
            if (view != null) scroll.smoothScrollTo(0, Math.max(0, view.getTop() - dp(48)));
        });
    }

    private static String role(AgentLoop.Message message) {
        if ("user".equals(message.role)) return "用户";
        if ("assistant".equals(message.role)) return "助手";
        if ("tool".equals(message.role)) return "工具";
        return "系统";
    }
    private static String summary(ConversationTree.Node node) {
        String content = node.message.content;
        if (content == null || content.isEmpty()) return node.message.toolCalls.isEmpty() ? "空消息" : "工具调用";
        return content.replace('\n', ' ');
    }
    private LinearLayout column() { LinearLayout v = new LinearLayout(getContext()); v.setOrientation(LinearLayout.VERTICAL); return v; }
    private LinearLayout row() { LinearLayout v = new LinearLayout(getContext()); v.setGravity(Gravity.CENTER_VERTICAL); return v; }
    private TextView text(String value, int size, int color) {
        TextView v = new TextView(getContext()); v.setText(value); v.setTextSize(size); v.setTextColor(color);
        v.setGravity(Gravity.CENTER_VERTICAL); return v;
    }
    private TextView button(String value, Runnable click) {
        TextView v = text(value, 14, INK); v.setGravity(Gravity.CENTER);
        v.setMinWidth(dp(48)); v.setMinHeight(dp(48)); v.setPadding(dp(12), 0, dp(12), 0);
        v.setFocusable(true); v.setOnClickListener(ignored -> click.run()); return v;
    }
    private GradientDrawable background(int color, int radius) {
        GradientDrawable d = new GradientDrawable(); d.setColor(color); d.setCornerRadius(dp(radius)); return d;
    }
    private int dp(int value) { return Math.round(value * getContext().getResources().getDisplayMetrics().density); }
}
