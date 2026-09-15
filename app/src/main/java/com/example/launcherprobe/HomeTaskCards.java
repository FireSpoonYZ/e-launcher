package com.example.launcherprobe;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.content.res.ColorStateList;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.animation.LinearInterpolator;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.function.Consumer;

/** Desktop projection of conversation runs; never mutates extension task states. */
final class HomeTaskCards extends LinearLayout {
    private final PagerRoot pager;
    private final AppAppearance colors;
    private final View wallpaper;
    private final Consumer<String> open, stop, dismiss;
    private JSONArray cards = new JSONArray();
    private String selected = "";
    private String rendered = "";
    private String displayed = "";
    private final Map<String, Integer> positions = new HashMap<>();
    private final Map<String, String> activeByConversation = new HashMap<>();
    private int followingTarget = -1;
    private boolean stripSettling;
    private boolean expanded = true;
    private int availableHeight = Integer.MAX_VALUE;
    private float downX, downY;
    private boolean swiping;
    private boolean touching;
    private boolean deferred;
    private final Runnable settleScroll = () -> {
        stripSettling = false;
        if (!touching && deferred) { deferred = false; render(); }
    };

    HomeTaskCards(Context context, PagerRoot pager, Consumer<String> open,
            Consumer<String> stop, Consumer<String> dismiss) {
        this(context, pager, AppAppearance.read(context).wallpaper(context), open, stop, dismiss);
    }

    HomeTaskCards(Context context, PagerRoot pager, View wallpaper, Consumer<String> open,
            Consumer<String> stop, Consumer<String> dismiss) {
        super(context);
        this.pager = pager;
        this.wallpaper = wallpaper;
        this.open = open;
        this.stop = stop;
        this.dismiss = dismiss;
        colors = AppAppearance.read(context);
        setOrientation(VERTICAL);
        setPadding(dp(12), dp(6), dp(12), dp(8));
        setClipChildren(false);
        setClipToPadding(false);
    }

    void update(JSONArray value) {
        cards = value;
        if (touching || stripSettling) { deferred = true; return; }
        render();
    }

    String selectedId() { return selected; }

    void setAvailableHeight(int height) { availableHeight = height; }

    private int index() {
        for (int i = 0; i < cards.length(); i++)
            if (selected.equals(cards.optJSONObject(i).optString("conversationId"))) return i;
        return 0;
    }

    static List<JSONObject> tasks(JSONObject card) {
        List<JSONObject> result = new ArrayList<>();
        JSONObject todo = card.optJSONObject("todo");
        if (todo == null || !"@juicesharp/rpiv-todo".equals(todo.optString("package"))) return result;
        JSONArray values = todo.optJSONArray("tasks");
        if (values != null) for (int i = 0; i < values.length(); i++) {
            JSONObject task = values.optJSONObject(i);
            if (task != null && !"deleted".equals(task.optString("status"))) result.add(task);
        }
        return result;
    }

    static boolean animateNode(String modelState, String taskState, boolean enabled) {
        return enabled && "working".equals(modelState) && "in_progress".equals(taskState);
    }

    private void render() {
        int index = index();
        JSONObject card = cards.optJSONObject(index);
        String signature = String.valueOf(card) + index + ":" + cards.length() + ":" + expanded;
        if (signature.equals(rendered)) return;
        rendered = signature;
        View oldStrip = findViewWithTag("todo-strip");
        if (oldStrip != null) positions.put(displayed, followingTarget >= 0 ? followingTarget : oldStrip.getScrollX());
        followingTarget = -1;
        removeCallbacks(settleScroll);
        stripSettling = false;
        deferred = false;
        removeAllViews();
        setVisibility(cards.length() == 0 ? GONE : VISIBLE);
        if (card == null) { selected = ""; return; }
        selected = card.optString("conversationId");
        String id = selected;
        displayed = id;
        String model = card.optString("modelState");
        List<JSONObject> tasks = tasks(card);
        long completed = tasks.stream().filter(task -> "completed".equals(task.optString("status"))).count();
        String active = tasks.stream().filter(task -> "in_progress".equals(task.optString("status")))
                .map(task -> task.optString("subject")).findFirst().orElse("");
        boolean working = "working".equals(model);
        String status = "stopping".equals(model) ? text("正在停止…", "Stopping…")
                : working ? (active.isEmpty() ? text("正在处理…", "Working…") : active)
                : !tasks.isEmpty() && completed == tasks.size() ? text("任务已完成", "Task complete")
                : !tasks.isEmpty() ? text("等待继续", "Ready to continue") : text("本轮已结束", "Run ended");
        LinearLayout panel = new LinearLayout(getContext());
        panel.setOrientation(VERTICAL);
        panel.setPadding(dp(20), dp(8), dp(20), dp(8));
        LinearLayout heading = new LinearLayout(getContext());
        heading.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = button(card.optString("title"), () -> open.accept(id));
        title.setTextSize(16);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        title.setMaxLines(1);
        title.setEllipsize(TextUtils.TruncateAt.END);
        heading.addView(title, new LayoutParams(0, -2, 1));
        TextView more = iconButton("more", text("任务选项", "Task options"), null);
        more.setOnClickListener(view -> {
            PopupMenu menu = new PopupMenu(getContext(), more, Gravity.END);
            menu.getMenu().add(text(expanded ? "收起任务" : "展开任务", expanded ? "Collapse task" : "Expand task"))
                    .setOnMenuItemClickListener(item -> { expanded = !expanded; render(); return true; });
            menu.getMenu().add(text("移除卡片", "Dismiss card"))
                    .setOnMenuItemClickListener(item -> { dismiss.accept(id); return true; });
            menu.show();
        });
        heading.addView(more, new LayoutParams(dp(48), dp(48)));
        panel.addView(heading);

        LinearLayout stateRow = new LinearLayout(getContext());
        stateRow.setGravity(Gravity.CENTER_VERTICAL);
        TextView state = label(status, expanded ? 25 : 14);
        state.setMaxLines(expanded ? 2 : 1);
        state.setEllipsize(TextUtils.TruncateAt.END);
        state.setTypeface(Typeface.create(expanded ? "sans-serif-medium" : "sans-serif", Typeface.NORMAL));
        state.setTextColor(expanded ? colors.ink : colors.muted);
        stateRow.addView(state, new LayoutParams(-2, -2, 1));
        if (working) {
            View dot = new View(getContext());
            GradientDrawable fill = new GradientDrawable();
            fill.setShape(GradientDrawable.OVAL); fill.setColor(colors.accent);
            dot.setBackground(fill);
            dot.setContentDescription(text("正在运行", "Running"));
            LayoutParams dotParams = new LayoutParams(dp(8), dp(8));
            dotParams.setMarginStart(dp(10));
            stateRow.addView(dot, dotParams);
        }
        LayoutParams stateParams = new LayoutParams(-1, -2);
        stateParams.topMargin = expanded ? dp(10) : 0;
        panel.addView(stateRow, stateParams);
        if (!tasks.isEmpty()) {
            TextView count = label(text("已完成 ", "Completed ") + completed + " / " + tasks.size()
                    + text(" 个步骤", " steps"), 14);
            count.setTextColor(colors.muted);
            count.setPadding(0, dp(5), 0, expanded ? 0 : dp(8));
            panel.addView(count);
            if (expanded) {
                HorizontalScrollView strip = taskStrip(tasks, model);
                restoreTaskPosition(strip, tasks, id);
                LayoutParams stripParams = new LayoutParams(-1, -2);
                stripParams.topMargin = dp(18);
                panel.addView(strip, stripParams);
            }
        }
        if (!expanded || tasks.isEmpty()) activeByConversation.put(id, null);
        if (expanded || !"idle".equals(model)) {
            LinearLayout actions = new LinearLayout(getContext());
            actions.setGravity(Gravity.CENTER_VERTICAL);
            TextView details = button(text("查看对话", "View chat"), () -> open.accept(id));
            decorate(details, "external", colors.ink);
            actions.addView(details, new LayoutParams(0, dp(48), 1));
            if (!"idle".equals(model)) {
                TextView cancel = button(text("stopping".equals(model) ? "正在停止…" : "停止",
                        "stopping".equals(model) ? "Stopping…" : "Stop"), () -> stop.accept(id));
                decorate(cancel, "stop", colors.error);
                cancel.setTextColor(colors.error);
                cancel.setEnabled(working);
                cancel.setAlpha(working ? 1f : .5f);
                cancel.setContentDescription(text("停止生成", "Stop generation"));
                actions.addView(cancel, new LayoutParams(-2, dp(48)));
            }
            LayoutParams actionParams = new LayoutParams(-1, -2);
            actionParams.topMargin = expanded ? dp(12) : dp(4);
            panel.addView(actions, actionParams);
        }
        if (cards.length() > 1) {
            LinearLayout navigation = new LinearLayout(getContext());
            navigation.setGravity(Gravity.CENTER);
            navigation.addView(iconButton("previous", text("上一个任务", "Previous task"), () -> move(-1)),
                    new LayoutParams(dp(48), dp(48)));
            TextView position = label((index + 1) + " / " + cards.length(), 14);
            position.setTextColor(colors.muted);
            position.setGravity(Gravity.CENTER);
            position.setMinWidth(dp(52));
            navigation.addView(position);
            navigation.addView(iconButton("next", text("下一个任务", "Next task"), () -> move(1)),
                    new LayoutParams(dp(48), dp(48)));
            panel.addView(navigation);
        }
        ScrollView bounded = new ScrollView(getContext()) {
            @Override protected void onMeasure(int w, int h) {
                int max = Math.min(getResources().getDisplayMetrics().heightPixels * 2 / 5,
                        Math.max(0, availableHeight - HomeTaskCards.this.getPaddingTop() - HomeTaskCards.this.getPaddingBottom()));
                super.onMeasure(w, MeasureSpec.makeMeasureSpec(max, MeasureSpec.AT_MOST));
            }
        };
        bounded.setVerticalScrollBarEnabled(false);
        bounded.setOverScrollMode(OVER_SCROLL_NEVER);
        bounded.addView(panel);
        FrameLayout glass = colors.glass(getContext(), wallpaper, 24);
        glass.addView(bounded, new FrameLayout.LayoutParams(-1, -2));
        addView(glass, new LayoutParams(-1, -2));
    }

    private void restoreTaskPosition(HorizontalScrollView strip, List<JSONObject> tasks, String id) {
        strip.addOnLayoutChangeListener(new OnLayoutChangeListener() {
            @Override public void onLayoutChange(View view, int left, int top, int right, int bottom,
                    int oldLeft, int oldTop, int oldRight, int oldBottom) {
                if (right == left || findViewWithTag("todo-strip") != strip) return;
                strip.removeOnLayoutChangeListener(this);
                int activeIndex = -1;
                for (int i = 0; i < tasks.size(); i++) {
                    if ("in_progress".equals(tasks.get(i).optString("status"))) { activeIndex = i; break; }
                }
                String activeId = activeIndex < 0 ? null : tasks.get(activeIndex).optString("id");
                boolean follow = activeId != null && (!activeByConversation.containsKey(id)
                        || !Objects.equals(activeByConversation.get(id), activeId));
                strip.scrollTo(positions.getOrDefault(id, 0), 0);
                activeByConversation.put(id, activeId);
                if (!follow) return;
                LinearLayout track = (LinearLayout) strip.getChildAt(0);
                View node = track.getChildAt(activeIndex);
                int target = Math.max(0, Math.min(node.getLeft() + node.getWidth() / 2 - strip.getWidth() / 2,
                        track.getWidth() - strip.getWidth()));
                followingTarget = target;
                positions.put(id, target);
                if (ValueAnimator.areAnimatorsEnabled()) strip.smoothScrollTo(target, 0);
                else strip.scrollTo(target, 0);
            }
        });
    }

    private void scheduleScrollSettle() {
        removeCallbacks(settleScroll);
        postDelayed(settleScroll, 160);
    }

    @Override protected void onDetachedFromWindow() {
        removeCallbacks(settleScroll);
        stripSettling = false;
        touching = false;
        super.onDetachedFromWindow();
    }

    private HorizontalScrollView taskStrip(List<JSONObject> tasks, String model) {
        HorizontalScrollView strip = new HorizontalScrollView(getContext());
        strip.setHorizontalScrollBarEnabled(false);
        strip.setOverScrollMode(OVER_SCROLL_NEVER);
        // The step strip scrolls independently; swiping the header switches conversations.
        strip.setTag("todo-strip");
        strip.setOnScrollChangeListener((view, x, y, oldX, oldY) -> {
            if (findViewWithTag("todo-strip") != view) return;
            if (x == followingTarget) followingTarget = -1;
            if (stripSettling) scheduleScrollSettle();
        });
        LinearLayout track = new LinearLayout(getContext()) {
            private final Paint line = new Paint(Paint.ANTI_ALIAS_FLAG);
            { setWillNotDraw(false); }
            @Override protected void onDraw(Canvas canvas) {
                super.onDraw(canvas);
                line.setStrokeWidth(dp(1));
                for (int i = 0; i + 1 < getChildCount(); i++) {
                    View a = getChildAt(i), b = getChildAt(i + 1);
                    line.setColor("completed".equals(tasks.get(i).optString("status"))
                            ? colors.accent : colors.border);
                    canvas.drawLine(a.getLeft() + a.getWidth() / 2f + dp(16), dp(24),
                            b.getLeft() + b.getWidth() / 2f - dp(16), dp(24), line);
                }
            }
        };
        int width = Math.max(dp(94), (int) ((getResources().getDisplayMetrics().widthPixels - dp(64)) / 3.25f));
        for (JSONObject task : tasks) {
            String status = task.optString("status");
            LinearLayout node = new LinearLayout(getContext());
            node.setOrientation(VERTICAL);
            node.setGravity(Gravity.CENTER_HORIZONTAL);
            node.setPadding(dp(4), dp(4), dp(4), dp(4));
            node.addView(new Marker(getContext(), status, model), new LayoutParams(dp(40), dp(40)));
            TextView subject = label(task.optString("subject"), 13);
            subject.setMaxLines(2);
            subject.setEllipsize(TextUtils.TruncateAt.END);
            subject.setTextColor("in_progress".equals(status) ? colors.ink : colors.muted);
            if ("in_progress".equals(status)) subject.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
            subject.setGravity(Gravity.CENTER);
            subject.setPadding(0, dp(7), 0, 0);
            node.addView(subject);
            node.setContentDescription(task.optString("subject") + ", " + taskStatus(status));
            track.addView(node, new LayoutParams(width, -2));
        }
        strip.addView(track);
        return strip;
    }

    private String taskStatus(String status) {
        return "completed".equals(status) ? text("已完成", "Completed")
                : "in_progress".equals(status) ? text("进行中", "In progress") : text("待开始", "Pending");
    }

    private boolean stripTouch;
    @Override public boolean dispatchTouchEvent(MotionEvent event) {
        if (event.getActionMasked() == MotionEvent.ACTION_DOWN) {
            pager.setGestureBlocked(pager.gestureId(), true);
            downX = event.getX(); downY = event.getY(); touching = true; swiping = false;
            View strip = findViewWithTag("todo-strip");
            android.graphics.Rect rect = new android.graphics.Rect();
            stripTouch = strip != null && strip.getGlobalVisibleRect(rect)
                    && rect.contains((int) event.getRawX(), (int) event.getRawY());
            removeCallbacks(settleScroll);
            stripSettling = false;
            if (stripTouch) followingTarget = -1;
        }
        boolean handled = super.dispatchTouchEvent(event);
        if (event.getActionMasked() == MotionEvent.ACTION_UP || event.getActionMasked() == MotionEvent.ACTION_CANCEL) {
            touching = false;
            if (stripTouch && event.getActionMasked() == MotionEvent.ACTION_UP) {
                stripSettling = true;
                scheduleScrollSettle();
            } else if (deferred) { deferred = false; render(); }
        }
        return handled;
    }

    @Override public boolean onInterceptTouchEvent(MotionEvent event) {
        if (!stripTouch && cards.length() > 1 && event.getActionMasked() == MotionEvent.ACTION_MOVE
                && Math.abs(event.getX() - downX) > ViewConfiguration.get(getContext()).getScaledTouchSlop()
                && Math.abs(event.getX() - downX) > Math.abs(event.getY() - downY) * 1.6f) {
            swiping = true;
            return true;
        }
        return false;
    }

    @Override public boolean onTouchEvent(MotionEvent event) {
        if (!swiping) return super.onTouchEvent(event);
        if (event.getActionMasked() == MotionEvent.ACTION_UP) {
            if (Math.abs(event.getX() - downX) > dp(40)) move(event.getX() < downX ? 1 : -1);
            swiping = false;
            performClick();
        }
        return true;
    }

    @Override public boolean performClick() { super.performClick(); return true; }

    private void move(int delta) {
        if (cards.length() == 0) return;
        selected = cards.optJSONObject(Math.floorMod(index() + delta, cards.length())).optString("conversationId");
        render();
    }

    private TextView label(String text, int size) {
        TextView view = new TextView(getContext());
        view.setText(text); view.setTextSize(size); view.setTextColor(colors.ink);
        view.setIncludeFontPadding(false);
        return view;
    }
    private TextView button(String text, Runnable action) {
        TextView view = label(text, 15);
        view.setGravity(Gravity.CENTER_VERTICAL);
        view.setMinHeight(dp(48)); view.setMinWidth(dp(48));
        GradientDrawable mask = new GradientDrawable();
        mask.setColor(0xffffffff); mask.setCornerRadius(dp(12));
        view.setBackground(new RippleDrawable(ColorStateList.valueOf(colors.dark ? 0x2475c3af : 0x18267a69), null, mask));
        view.setFocusable(true);
        if (action != null) view.setOnClickListener(v -> action.run());
        return view;
    }
    private TextView iconButton(String name, String description, Runnable action) {
        TextView view = button("", action);
        decorate(view, name, colors.muted);
        view.setPadding(dp(13), dp(13), dp(13), dp(13));
        view.setContentDescription(description);
        return view;
    }
    private void decorate(TextView view, String icon, int color) {
        ChatIcon drawable = new ChatIcon(icon, color);
        drawable.setBounds(0, 0, dp(22), dp(22));
        view.setCompoundDrawablesRelative(drawable, null, null, null);
        view.setCompoundDrawablePadding(dp(8));
    }
    private String text(String chinese, String english) {
        return getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh") ? chinese : english;
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private final class Marker extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final String status, model;
        private ValueAnimator animator;
        private float angle;
        Marker(Context context, String status, String model) {
            super(context); this.status = status; this.model = model;
            setContentDescription(taskStatus(status));
        }
        @Override protected void onAttachedToWindow() { super.onAttachedToWindow(); updateAnimation(); }
        @Override protected void onWindowVisibilityChanged(int visibility) {
            super.onWindowVisibilityChanged(visibility); updateAnimation();
        }
        @Override protected void onVisibilityChanged(View changed, int visibility) {
            super.onVisibilityChanged(changed, visibility); updateAnimation();
        }
        private void updateAnimation() {
            if (animator != null) { animator.cancel(); animator = null; }
            if (isAttachedToWindow() && isShown() && getWindowVisibility() == VISIBLE && animateNode(model, status, ValueAnimator.areAnimatorsEnabled())) {
                animator = ValueAnimator.ofFloat(0, 360);
                animator.setDuration(1200); animator.setRepeatCount(ValueAnimator.INFINITE);
                animator.setInterpolator(new LinearInterpolator());
                animator.addUpdateListener(value -> { angle = (float) value.getAnimatedValue(); invalidate(); });
                animator.start();
            }
        }
        @Override protected void onDetachedFromWindow() {
            if (animator != null) { animator.cancel(); animator = null; }
            super.onDetachedFromWindow();
        }
        @Override protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            float x = getWidth() / 2f, y = getHeight() / 2f, radius = dp(13);
            boolean completed = "completed".equals(status), active = "in_progress".equals(status);
            paint.setColor(active || completed ? colors.accent : colors.muted);
            paint.setStrokeWidth(dp(1) * 1.5f);
            paint.setStyle(completed ? Paint.Style.FILL : Paint.Style.STROKE);
            canvas.drawCircle(x, y, radius, paint);
            if (completed) {
                paint.setColor(colors.dark ? colors.background : 0xffffffff);
                paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(dp(2));
                paint.setStrokeCap(Paint.Cap.ROUND);
                canvas.drawLine(x - dp(5), y, x - dp(1), y + dp(4), paint);
                canvas.drawLine(x - dp(1), y + dp(4), x + dp(5), y - dp(4), paint);
            } else if (active) {
                paint.setStyle(Paint.Style.FILL);
                canvas.drawCircle(x, y, dp(8), paint);
                paint.setStyle(Paint.Style.STROKE);
                paint.setAlpha(40); paint.setStrokeWidth(dp(1));
                canvas.drawCircle(x, y, radius + dp(4), paint); paint.setAlpha(255);
                paint.setStrokeWidth(dp(2));
                if (animator != null) canvas.drawArc(new RectF(x-radius-dp(4), y-radius-dp(4), x+radius+dp(4), y+radius+dp(4)), angle, 85, false, paint);
            }
        }
    }
}
