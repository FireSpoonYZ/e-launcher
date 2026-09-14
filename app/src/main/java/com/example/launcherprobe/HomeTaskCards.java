package com.example.launcherprobe;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.animation.LinearInterpolator;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

/** Desktop projection of conversation runs; never mutates extension task states. */
final class HomeTaskCards extends LinearLayout {
    private final PagerRoot pager;
    private final AppAppearance colors;
    private final Consumer<String> open, stop, dismiss;
    private JSONArray cards = new JSONArray();
    private String selected = "";
    private String rendered = "";
    private boolean expanded;
    private float downX, downY;
    private boolean swiping;
    private boolean touching;
    private boolean deferred;

    HomeTaskCards(Context context, PagerRoot pager, Consumer<String> open,
            Consumer<String> stop, Consumer<String> dismiss) {
        super(context);
        this.pager = pager;
        this.open = open;
        this.stop = stop;
        this.dismiss = dismiss;
        colors = AppAppearance.read(context);
        setOrientation(VERTICAL);
        setPadding(dp(12), dp(4), dp(12), 0);
    }

    void update(JSONArray value) {
        cards = value;
        if (touching) { deferred = true; return; }
        render();
    }

    String selectedId() { return selected; }

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
        int scrollX = oldStrip == null ? 0 : oldStrip.getScrollX();
        boolean sameCard = card != null && selected.equals(card.optString("conversationId"));
        removeAllViews();
        setVisibility(cards.length() == 0 ? GONE : VISIBLE);
        if (card == null) { selected = ""; return; }
        selected = card.optString("conversationId");
        String id = selected;
        String model = card.optString("modelState");
        LinearLayout panel = new LinearLayout(getContext());
        panel.setOrientation(VERTICAL);
        panel.setPadding(dp(14), dp(8), dp(14), dp(8));
        GradientDrawable background = new GradientDrawable();
        background.setColor(colors.background);
        background.setCornerRadius(dp(20));
        background.setStroke(dp(1), colors.border);
        panel.setBackground(background);
        LinearLayout heading = new LinearLayout(getContext());
        heading.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = button(card.optString("title"), () -> { expanded = !expanded; render(); });
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        heading.addView(title, new LayoutParams(0, -2, 1));
        TextView toggle = button(expanded ? "⌄" : "⌃", () -> { expanded = !expanded; render(); });
        toggle.setContentDescription(text(expanded ? "收起任务" : "展开任务", expanded ? "Collapse task" : "Expand task"));
        heading.addView(toggle, new LayoutParams(dp(44), -2));
        TextView close = button("×", () -> { dismiss.accept(id); });
        close.setContentDescription(text("关闭任务卡片", "Dismiss task card"));
        heading.addView(close, new LayoutParams(dp(44), -2));
        panel.addView(heading);
        TextView state = label("working".equals(model) ? text("模型正在工作", "Model working")
                : "stopping".equals(model) ? text("正在停止…", "Stopping…") : text("模型空闲", "Model idle"), 13);
        state.setTextColor("working".equals(model) ? colors.accent : colors.muted);
        panel.addView(state);
        List<JSONObject> tasks = tasks(card);
        if (!tasks.isEmpty()) {
            long completed = tasks.stream().filter(task -> "completed".equals(task.optString("status"))).count();
            TextView count = label(text("已完成 ", "Completed ") + completed + "/" + tasks.size()
                    + text(" 个步骤", " steps"), 13);
            count.setPadding(0, dp(8), 0, dp(8));
            panel.addView(count);
            if (expanded) {
                // The step strip scrolls independently; swiping the header switches conversations.
                HorizontalScrollView strip = new HorizontalScrollView(getContext());
                strip.setHorizontalScrollBarEnabled(false);
                LinearLayout track = new LinearLayout(getContext()) {
                    private final Paint line = new Paint(Paint.ANTI_ALIAS_FLAG);
                    { setWillNotDraw(false); }
                    @Override protected void onDraw(Canvas canvas) {
                        super.onDraw(canvas);
                        line.setColor(colors.border); line.setStrokeWidth(dp(1));
                        for (int i = 0; i + 1 < getChildCount(); i++) {
                            View a = getChildAt(i), b = getChildAt(i + 1);
                            canvas.drawLine(a.getLeft() + a.getWidth() / 2f + dp(16), dp(20),
                                    b.getLeft() + b.getWidth() / 2f - dp(16), dp(20), line);
                        }
                    }
                };
                int width = Math.max(dp(100), (getResources().getDisplayMetrics().widthPixels - dp(60)) / 3);
                for (JSONObject task : tasks) {
                    LinearLayout node = new LinearLayout(getContext());
                    node.setOrientation(VERTICAL);
                    node.setGravity(Gravity.CENTER_HORIZONTAL);
                    node.setPadding(dp(5), dp(4), dp(5), dp(8));
                    node.addView(new Marker(getContext(), task.optString("status"), model), new LayoutParams(dp(32), dp(32)));
                    TextView subject = label(task.optString("subject"), 13);
                    subject.setGravity(Gravity.CENTER);
                    subject.setPadding(0, dp(6), 0, 0);
                    node.addView(subject);
                    track.addView(node, new LayoutParams(width, -2));
                }
                strip.addView(track);
                if (sameCard) strip.post(() -> strip.scrollTo(scrollX, 0));
                // Let this region own horizontal dragging instead of the card pager.
                strip.setTag("todo-strip");
                panel.addView(strip);
            }
        }
        if (expanded) {
            LinearLayout actions = new LinearLayout(getContext());
            actions.addView(button(text("在聊天中查看详情", "View conversation"), () -> open.accept(id)), new LayoutParams(0, -2, 1));
            if (!"idle".equals(model)) {
                TextView cancel = button(text("停止生成", "Stop"), () -> stop.accept(id));
                cancel.setTextColor(colors.error);
                cancel.setEnabled("working".equals(model));
                actions.addView(cancel);
            }
            panel.addView(actions);
        }
        ScrollView bounded = new ScrollView(getContext()) {
            @Override protected void onMeasure(int w, int h) {
                int max = getResources().getDisplayMetrics().heightPixels * 2 / 5;
                super.onMeasure(w, MeasureSpec.makeMeasureSpec(max, MeasureSpec.AT_MOST));
            }
        };
        bounded.addView(panel);
        addView(bounded);
        if (cards.length() > 1) {
            LinearLayout navigation = new LinearLayout(getContext());
            navigation.setGravity(Gravity.CENTER);
            navigation.addView(button("‹", () -> move(-1)));
            TextView position = label((index + 1) + " / " + cards.length(), 12);
            navigation.addView(position);
            navigation.addView(button("›", () -> move(1)));
            addView(navigation);
        }
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
        }
        boolean handled = super.dispatchTouchEvent(event);
        if (event.getActionMasked() == MotionEvent.ACTION_UP || event.getActionMasked() == MotionEvent.ACTION_CANCEL) {
            touching = false;
            if (deferred) { deferred = false; render(); }
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
        return view;
    }
    private TextView button(String text, Runnable action) {
        TextView view = label(text, 15);
        view.setGravity(Gravity.CENTER_VERTICAL);
        view.setMinHeight(dp(44)); view.setMinWidth(dp(44));
        view.setFocusable(true); view.setOnClickListener(v -> action.run());
        return view;
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
            setContentDescription(status);
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
            float x = getWidth() / 2f, y = getHeight() / 2f, radius = dp(10);
            boolean completed = "completed".equals(status), active = "in_progress".equals(status);
            paint.setColor(active || completed ? colors.accent : colors.muted);
            paint.setStrokeWidth(dp(active ? 3 : 2));
            paint.setStyle(completed ? Paint.Style.FILL : Paint.Style.STROKE);
            canvas.drawCircle(x, y, radius, paint);
            if (completed) {
                paint.setColor(colors.background); paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(dp(2));
                canvas.drawLine(x - dp(5), y, x - dp(1), y + dp(4), paint);
                canvas.drawLine(x - dp(1), y + dp(4), x + dp(5), y - dp(4), paint);
            } else if (active) {
                paint.setAlpha(40); paint.setStrokeWidth(dp(2));
                canvas.drawCircle(x, y, radius + dp(4), paint); paint.setAlpha(255);
                if (animator != null) canvas.drawArc(new RectF(x-radius-dp(4), y-radius-dp(4), x+radius+dp(4), y+radius+dp(4)), angle, 85, false, paint);
            }
        }
    }
}
