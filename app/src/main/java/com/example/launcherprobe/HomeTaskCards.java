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
    private int availableHeight = Integer.MAX_VALUE;
    private boolean editing;
    private float downX, downY;
    private int axis;
    private boolean swiping;
    private boolean steal;
    private boolean touching;
    private boolean bodyTouch;
    private boolean deferred;
    private ScrollView bodyScroll;
    private View switchingOut;
    private int switchDirection;
    private final Runnable settleScroll = () -> {
        stripSettling = false;
        if (!touching && deferred) { deferred = false; render(); }
    };

    HomeTaskCards(Context context, PagerRoot pager, Consumer<String> open,
            Consumer<String> stop, Consumer<String> dismiss) {
        this(context, pager, AppAppearance.readDesktop(context).wallpaper(context), open, stop, dismiss);
    }

    HomeTaskCards(Context context, PagerRoot pager, View wallpaper, Consumer<String> open,
            Consumer<String> stop, Consumer<String> dismiss) {
        super(context);
        this.pager = pager;
        this.wallpaper = wallpaper;
        this.open = open;
        this.stop = stop;
        this.dismiss = dismiss;
        colors = AppAppearance.readDesktop(context);
        setOrientation(VERTICAL);
        setPadding(0, 0, 0, 0);
        setClipChildren(false);
        setClipToPadding(false);
    }

    void update(JSONArray value) {
        cards = new JSONArray();
        if (value != null) for (int i = 0; i < Math.min(5, value.length()); i++)
            if (value.optJSONObject(i) != null) cards.put(value.optJSONObject(i));
        if (touching || stripSettling) { deferred = true; return; }
        render();
    }

    String selectedId() { return selected; }

    /** Invoke only when returning to the desktop, not on background refreshes. */
    void showLatest() { selected = ""; rendered = ""; render(); }

    private void detail(String id) {
        getContext().startActivity(new android.content.Intent(getContext(), TaskDetailActivity.class)
                .putExtra(TaskDetailActivity.EXTRA_CONVERSATION_ID, id));
    }

    void setAvailableHeight(int height) { availableHeight = height; }
    void setEditing(boolean value) {
        if (editing == value) return;
        editing = value; render();
    }

    @Override protected void onMeasure(int widthSpec, int heightSpec) {
        if (availableHeight != Integer.MAX_VALUE)
            heightSpec = MeasureSpec.makeMeasureSpec(availableHeight, MeasureSpec.EXACTLY);
        super.onMeasure(widthSpec, heightSpec);
    }

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

    static String status(JSONObject card) {
        String model = card.optString("modelState");
        if ("working".equals(model)) return "正在执行";
        if ("stopping".equals(model)) return "正在停止…";
        if ("error".equals(card.optString("runStatus"))) return "执行失败";
        if ("aborted".equals(card.optString("runStatus"))) return "已停止";
        List<JSONObject> steps = tasks(card);
        if (steps.isEmpty()) return "对话已结束";
        return steps.stream().allMatch(t -> "completed".equals(t.optString("status"))) ? "已完成" : "本轮已结束";
    }

    static boolean animateNode(String modelState, String taskState, boolean enabled) {
        return enabled && "working".equals(modelState) && "in_progress".equals(taskState);
    }

    private void render() {
        int index = index();
        JSONObject card = cards.optJSONObject(index);
        String signature = String.valueOf(card) + index + ":" + cards.length() + ":" + editing;
        if (signature.equals(rendered)) return;
        rendered = signature;
        View oldStrip = findViewWithTag("todo-strip");
        if (oldStrip != null) positions.put(displayed, followingTarget >= 0 ? followingTarget : oldStrip.getScrollX());
        followingTarget = -1;
        removeCallbacks(settleScroll);
        stripSettling = false; deferred = false;
        removeAllViews(); setVisibility(VISIBLE);

        LinearLayout panel = new LinearLayout(getContext());
        panel.setOrientation(VERTICAL);
        panel.setPadding(dp(14), dp(4), dp(14), dp(10));
        FrameLayout glass = colors.glass(getContext(), wallpaper, 22);
        glass.addView(panel, new FrameLayout.LayoutParams(-1, -1));
        if (card == null) {
            selected = "";
            bodyScroll = null;
            TextView brand = label(text("AI 助手", "AI assistant"), 15);
            decorate(brand, "sparkles", colors.accent);
            brand.setGravity(Gravity.CENTER_VERTICAL);
            brand.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
            panel.addView(brand, new LayoutParams(-1, dp(40)));
            LinearLayout message = new LinearLayout(getContext());
            message.setOrientation(VERTICAL); message.setGravity(Gravity.CENTER);
            android.widget.ImageView star = new android.widget.ImageView(getContext());
            star.setImageDrawable(new ChatIcon("sparkles", colors.accent));
            message.addView(star, new LayoutParams(dp(56), dp(56)));
            TextView prompt = label(text("开始一个新对话", "Start a new conversation"), 16);
            prompt.setPadding(0, dp(12), 0, 0); message.addView(prompt);
            panel.addView(message, new LayoutParams(-1, 0, 1));
            TextView start = button(text("开始对话", "Start conversation"), () -> open.accept(""));
            start.setGravity(Gravity.CENTER); start.setTextColor(0xffffffff);
            start.setBackground(fill(colors.accent, 18));
            LayoutParams startParams = new LayoutParams(-1, dp(48));
            startParams.setMargins(dp(32), dp(8), dp(32), dp(4));
            panel.addView(start, startParams);
            present(glass); return;
        }
        selected = card.optString("conversationId");
        String id = selected; displayed = id;
        String model = card.optString("modelState");
        List<JSONObject> tasks = tasks(card);
        long completed = tasks.stream().filter(task -> "completed".equals(task.optString("status"))).count();
        LinearLayout heading = new LinearLayout(getContext());
        heading.setGravity(Gravity.CENTER_VERTICAL); heading.setTag("card-switch");
        heading.setOnClickListener(v -> detail(id));
        heading.setContentDescription(text("查看任务详情", "View task details"));
        TextView brand = label(text("AI 助手", "AI assistant"), 15);
        brand.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        decorate(brand, "sparkles", colors.accent);
        heading.addView(brand);
        TextView state = label(status(card), 10);
        state.setTextColor(colors.accent); state.setPadding(dp(8), dp(4), dp(8), dp(4));
        state.setBackground(fill(colors.dark ? 0xff254c59 : 0xffd9f3f7, 20));
        LayoutParams stateParams = new LayoutParams(-2, -2); stateParams.setMarginStart(dp(8));
        heading.addView(state, stateParams);
        View space = new View(getContext()); heading.addView(space, new LayoutParams(0, 1, 1));
        TextView position = label(text("对话 ", "Chat ") + (index + 1) + "/" + cards.length(), 11);
        position.setTextColor(colors.muted); heading.addView(position);
        if (cards.length() > 1) heading.addView(new ConversationSwitch(), new LayoutParams(dp(48), dp(48)));
        panel.addView(heading, new LayoutParams(-1, dp(48)));

        LinearLayout body = new LinearLayout(getContext()); body.setOrientation(VERTICAL);
        TextView title = label(card.optString("title"), 17);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        title.setMaxLines(1); title.setEllipsize(TextUtils.TruncateAt.END);
        title.setOnClickListener(v -> detail(id)); body.addView(title);
        TextView count = label(tasks.isEmpty() ? text("打开对话查看完整内容", "Open the conversation for details")
                : text("已完成 ", "Completed ") + completed + text(" 项，共 ", " of ") + tasks.size() + text(" 项", " steps"), 12);
        count.setTextColor(colors.muted); count.setPadding(0, dp(4), 0, 0); body.addView(count);
        if (!tasks.isEmpty() && !editing) {
            HorizontalScrollView strip = taskStrip(tasks, model);
            restoreTaskPosition(strip, tasks, id);
            LayoutParams stripParams = new LayoutParams(-1, -2); stripParams.topMargin = dp(7);
            body.addView(strip, stripParams);
        } else activeByConversation.put(id, null);
        bodyScroll = new ScrollView(getContext());
        bodyScroll.setVerticalScrollBarEnabled(false); bodyScroll.setOverScrollMode(OVER_SCROLL_NEVER);
        bodyScroll.addView(body); panel.addView(bodyScroll, new LayoutParams(-1, 0, 1));

        LinearLayout actions = new LinearLayout(getContext());
        boolean busy = !"idle".equals(model);
        TextView left = button(busy ? text("stopping".equals(model) ? "正在停止…" : "停止", "Stop")
                : text("删除", "Delete"), () -> { if (busy) stop.accept(id); else dismiss.accept(id); });
        left.setTextColor(colors.error); left.setGravity(Gravity.CENTER);
        left.setEnabled(!"stopping".equals(model));
        left.setBackground(fill(colors.dark ? 0xff4a303c : 0xfff4dfe4, 16));
        actions.addView(left, new LayoutParams(0, dp(48), 1));
        TextView chat = button(text("查看对话", "View chat"), () -> open.accept(id));
        chat.setGravity(Gravity.CENTER); chat.setTextColor(0xffffffff);
        chat.setBackground(fill(colors.accent, 16));
        LayoutParams chatParams = new LayoutParams(0, dp(48), 1); chatParams.setMarginStart(dp(8));
        actions.addView(chat, chatParams);
        LayoutParams actionParams = new LayoutParams(-1, dp(48)); actionParams.topMargin = dp(7);
        panel.addView(actions, actionParams);

        FrameLayout stack = new FrameLayout(getContext());
        int layers = Math.min(2, cards.length() - 1);
        for (int layer = layers; layer > 0; layer--) {
            View back = new View(getContext());
            back.setBackground(fill(colors.dark ? 0xb3375a66 : 0xa3f2fdff, 22));
            back.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
            FrameLayout.LayoutParams p = new FrameLayout.LayoutParams(-1, -1);
            p.setMargins(dp(layer * 7), dp(layer * 4), dp(layer * 7), 0); stack.addView(back, p);
        }
        FrameLayout.LayoutParams front = new FrameLayout.LayoutParams(-1, -1);
        front.bottomMargin = dp(layers * 4); stack.addView(glass, front);
        present(stack);
    }

    private void present(View incoming) {
        View keep = switchingOut;
        switchingOut = null;
        FrameLayout viewport = new FrameLayout(getContext());
        viewport.addView(incoming, new FrameLayout.LayoutParams(-1, -1));
        addView(viewport, new LayoutParams(-1, -1));
        if (keep == null || !Motion.enabled()) return;
        float distance = Math.max(dp(96), getHeight());
        float out = switchDirection > 0 ? -distance : distance;
        incoming.setTranslationY(-out / 4f);
        incoming.setAlpha(.8f);
        viewport.addView(keep, new FrameLayout.LayoutParams(-1, -1));
        keep.animate().translationY(out).alpha(0f).setDuration(Motion.LOCAL).setInterpolator(Motion.EASE)
                .withEndAction(() -> { if (keep.getParent() == viewport) viewport.removeView(keep); }).start();
        incoming.animate().translationY(0).alpha(1f).setDuration(Motion.LOCAL).setInterpolator(Motion.EASE).start();
    }

    private GradientDrawable fill(int color, int radius) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color); drawable.setCornerRadius(dp(radius)); return drawable;
    }

    private final class ConversationSwitch extends View {
        private int direction = 1;
        private final ChatIcon up = new ChatIcon("up", colors.muted), down = new ChatIcon("down", colors.muted);
        ConversationSwitch() {
            super(HomeTaskCards.this.getContext()); setClickable(true); setFocusable(true);
            setContentDescription(text("切换对话，上半部为上一个，下半部为下一个", "Switch conversation: previous above, next below"));
        }
        @Override protected void onDraw(Canvas canvas) {
            int x = (getWidth() - dp(16)) / 2;
            up.setBounds(x, dp(6), x + dp(16), dp(22)); up.draw(canvas);
            down.setBounds(x, dp(26), x + dp(16), dp(42)); down.draw(canvas);
        }
        @Override public boolean onTouchEvent(MotionEvent event) {
            if (event.getActionMasked() == MotionEvent.ACTION_DOWN) direction = event.getY() < getHeight() / 2f ? -1 : 1;
            return super.onTouchEvent(event);
        }
        @Override public boolean performClick() { super.performClick(); move(direction); direction = 1; return true; }
        @Override public void onInitializeAccessibilityNodeInfo(android.view.accessibility.AccessibilityNodeInfo info) {
            super.onInitializeAccessibilityNodeInfo(info);
            info.setClassName("android.widget.Button");
            info.addAction(new android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction(4096, text("下一个对话", "Next conversation")));
            info.addAction(new android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction(8192, text("上一个对话", "Previous conversation")));
        }
        @Override public boolean performAccessibilityAction(int action, android.os.Bundle arguments) {
            if (action == 4096 || action == 8192) { move(action == 4096 ? 1 : -1); return true; }
            return super.performAccessibilityAction(action, arguments);
        }
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
                    canvas.drawLine(a.getLeft() + a.getWidth() / 2f + dp(13), dp(19),
                            b.getLeft() + b.getWidth() / 2f - dp(13), dp(19), line);
                }
            }
        };
        int width = Math.max(dp(58), (getResources().getDisplayMetrics().widthPixels - dp(60)) / Math.min(5, tasks.size()));
        for (JSONObject task : tasks) {
            String status = task.optString("status");
            LinearLayout node = new LinearLayout(getContext());
            node.setOrientation(VERTICAL);
            node.setGravity(Gravity.CENTER_HORIZONTAL);
            node.setPadding(dp(2), dp(2), dp(2), dp(2));
            node.addView(new TaskStepMarker(getContext(), status, model, colors.accent), new LayoutParams(dp(34), dp(34)));
            TextView subject = label(task.optString("subject"), 11);
            subject.setMaxLines(1);
            subject.setEllipsize(TextUtils.TruncateAt.END);
            subject.setTextColor("in_progress".equals(status) ? colors.ink : colors.muted);
            if ("in_progress".equals(status)) subject.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
            subject.setGravity(Gravity.CENTER);
            subject.setPadding(0, dp(4), 0, 0);
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
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
            if (pager != null) pager.setGestureBlocked(pager.gestureId(), true);
            downX = event.getX(); downY = event.getY();
            touching = true; swiping = false; steal = false; axis = 0;
            stripTouch = hit(findViewWithTag("todo-strip"), event);
            bodyTouch = bodyScroll != null && hit(bodyScroll, event);
            removeCallbacks(settleScroll);
            stripSettling = false;
            if (stripTouch) followingTarget = -1;
        } else if (action == MotionEvent.ACTION_MOVE) lockAxis(event);
        boolean handled = super.dispatchTouchEvent(event);
        if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
            touching = false;
            if (getParent() != null) getParent().requestDisallowInterceptTouchEvent(false);
            if (action == MotionEvent.ACTION_UP && pager != null)
                pager.setGestureBlocked(pager.gestureId(), false);
            if (stripTouch && action == MotionEvent.ACTION_UP) {
                stripSettling = true;
                scheduleScrollSettle();
            } else if (deferred) { deferred = false; render(); }
        }
        return handled;
    }

    private void lockAxis(MotionEvent event) {
        if (axis != 0) return;
        float dx = event.getX() - downX, dy = event.getY() - downY;
        int slop = ViewConfiguration.get(getContext()).getScaledTouchSlop();
        if (Math.abs(dx) <= slop && Math.abs(dy) <= slop) return;
        axis = Math.abs(dx) > Math.abs(dy) * 1.1f ? 1 : 2;
        if (axis == 2) {
            boolean keep = bodyTouch && overflowing(bodyScroll) && bodyScroll.canScrollVertically(dy < 0 ? 1 : -1);
            if (keep || cards.length() > 1) {
                if (getParent() != null) getParent().requestDisallowInterceptTouchEvent(true);
                if (!keep && cards.length() > 1) swiping = steal = true;
            }
        } else {
            View strip = findViewWithTag("todo-strip");
            boolean keep = stripTouch && overflowing(strip) && strip.canScrollHorizontally(dx < 0 ? 1 : -1);
            if (getParent() != null) getParent().requestDisallowInterceptTouchEvent(keep);
            steal = !keep;
        }
    }

    private boolean hit(View view, MotionEvent event) {
        android.graphics.Rect rect = new android.graphics.Rect();
        return view != null && view.getGlobalVisibleRect(rect)
                && rect.contains((int) event.getRawX(), (int) event.getRawY());
    }

    private static boolean overflowing(View view) {
        if (view instanceof ScrollView scroll) {
            View child = scroll.getChildCount() == 0 ? null : scroll.getChildAt(0);
            return child != null && child.getHeight() > scroll.getHeight();
        }
        if (view instanceof HorizontalScrollView strip) {
            View child = strip.getChildCount() == 0 ? null : strip.getChildAt(0);
            return child != null && child.getWidth() > strip.getWidth();
        }
        return false;
    }

    @Override public boolean onInterceptTouchEvent(MotionEvent event) {
        return steal;
    }

    @Override public boolean onTouchEvent(MotionEvent event) {
        if (!swiping) {
            if (!steal) return super.onTouchEvent(event);
            if (event.getActionMasked() == MotionEvent.ACTION_UP || event.getActionMasked() == MotionEvent.ACTION_CANCEL)
                steal = false;
            return true;
        }
        View front = getChildCount() == 0 ? null : getChildAt(0);
        if (event.getActionMasked() == MotionEvent.ACTION_MOVE) {
            float offset = event.getY() - downY;
            if (front != null) {
                front.setTranslationY(offset);
                front.setAlpha(1f - Math.min(.35f, Math.abs(offset) / Math.max(1f, getHeight())));
            }
            return true;
        }
        if (event.getActionMasked() == MotionEvent.ACTION_UP || event.getActionMasked() == MotionEvent.ACTION_CANCEL) {
            boolean commit = event.getActionMasked() == MotionEvent.ACTION_UP && Math.abs(event.getY() - downY) > dp(40);
            if (commit) move(event.getY() < downY ? 1 : -1);
            else if (front != null) {
                Motion.spring(front, androidx.dynamicanimation.animation.DynamicAnimation.TRANSLATION_Y, 0, 0,
                        (a, canceled, value, velocity) -> front.setAlpha(1f));
                front.animate().alpha(1f).setDuration(Motion.LOCAL).start();
            }
            swiping = steal = false;
            performClick();
        }
        return true;
    }

    @Override public boolean performClick() { super.performClick(); return true; }

    private void move(int delta) {
        if (cards.length() == 0) return;
        switchDirection = delta;
        switchingOut = getChildCount() == 0 ? null : getChildAt(0);
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
        Motion.press(view);
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

}
