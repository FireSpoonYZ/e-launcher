package com.example.launcherprobe;

import android.content.Context;
import android.view.MotionEvent;
import android.view.VelocityTracker;
import android.view.View;
import android.view.ViewConfiguration;
import android.widget.FrameLayout;

import androidx.dynamicanimation.animation.FloatValueHolder;
import androidx.dynamicanimation.animation.SpringAnimation;

/** A continuous [chat][home] track. Neither page is recreated during a swipe. */
final class PagerRoot extends FrameLayout {
    interface Listener { void onPageChanged(PagerState.Page page); }

    private final View chat;
    private final Listener listener;
    private final int touchSlop;
    private final float minimumFlingVelocity;
    private View home;
    private PagerState.Page page;
    private VelocityTracker velocity;
    private SpringAnimation animation;
    private float downX, downY, startTrack, track, settleVelocity;
    private boolean dragging, rejected;
    // JavascriptInterface runs on the WebView bridge thread. Ignore replies to old touches.
    private volatile int gestureId;
    private volatile int allowedGestureId = -1;

    PagerRoot(Context context, View chat, PagerState.Page initialPage, Listener listener) {
        super(context);
        this.chat = chat;
        this.page = initialPage;
        this.listener = listener;
        ViewConfiguration configuration = ViewConfiguration.get(context);
        touchSlop = configuration.getScaledTouchSlop();
        minimumFlingVelocity = Math.max(configuration.getScaledMinimumFlingVelocity(),
                600 * getResources().getDisplayMetrics().density);
        setClipChildren(true);
        setFocusableInTouchMode(true);
        setClickable(true);
        addView(chat, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
    }

    void setHome(View value) {
        if (home != null) removeView(home);
        home = value;
        addView(home, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
        applyTrack(PagerState.endpoint(page, getWidth()));
        applyAccessibility();
    }

    PagerState.Page page() { return page; }
    int gestureId() { return gestureId; }
    void setGestureBlocked(int id, boolean blocked) {
        if (id == gestureId) allowedGestureId = blocked ? -1 : id;
    }

    void show(PagerState.Page target, boolean animated) {
        dragging = false;
        recycleVelocity();
        if (target == PagerState.Page.HOME) hideKeyboard();
        if (getWidth() == 0 || !animated || !Motion.enabled()) {
            cancelAnimation();
            finishAt(target);
        } else animateTo(target);
    }

    @Override protected void onSizeChanged(int width, int height, int oldWidth, int oldHeight) {
        super.onSizeChanged(width, height, oldWidth, oldHeight);
        if (width != oldWidth) {
            cancelAnimation();
            dragging = false;
            rejected = true;
            applyTrack(PagerState.endpoint(page, width));
            applyAccessibility();
        }
    }

    @Override public boolean dispatchTouchEvent(MotionEvent event) {
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
            cancelAnimation();
            recycleVelocity();
            velocity = VelocityTracker.obtain();
            downX = event.getX();
            downY = event.getY();
            startTrack = track;
            dragging = rejected = false;
            gestureId++;
            allowedGestureId = page == PagerState.Page.HOME ? gestureId : -1;
        }
        if (action == MotionEvent.ACTION_POINTER_DOWN) rejected = true;
        if (velocity != null) velocity.addMovement(event);
        boolean handled = super.dispatchTouchEvent(event);
        if ((action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) && !dragging) {
            recycleVelocity();
            if (animation == null && track != PagerState.endpoint(page, getWidth())) animateTo(page);
        }
        return handled;
    }

    @Override public void requestDisallowInterceptTouchEvent(boolean disallowIntercept) {
        // ScrollView/WebView request this for vertical scrolling too. Direction locks below;
        // the local document separately authorizes only gestures outside interactive regions.
    }

    @Override public boolean onInterceptTouchEvent(MotionEvent event) {
        if (event.getActionMasked() != MotionEvent.ACTION_MOVE || rejected) return false;
        float dx = event.getX() - downX, dy = event.getY() - downY;
        if (Math.abs(dy) > touchSlop && Math.abs(dy) >= Math.abs(dx)) {
            rejected = true;
            return false;
        }
        if (allowedGestureId != gestureId || Math.abs(dx) <= touchSlop
                || Math.abs(dx) <= Math.abs(dy) * 1.6f) return false;
        if ((startTrack == 0 && dx < 0) || (startTrack == getWidth() && dx > 0)) {
            rejected = true;
            return false;
        }
        dragging = true;
        if (home != null) home.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        chat.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        applyTrack(startTrack + dx);
        return true;
    }

    @Override public boolean onTouchEvent(MotionEvent event) {
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_MOVE:
                if (dragging && !rejected) applyTrack(startTrack + event.getX() - downX);
                return true;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                float velocityX = 0;
                if (velocity != null) {
                    velocity.computeCurrentVelocity(1000);
                    velocityX = velocity.getXVelocity();
                }
                PagerState.Page target = PagerState.settle(page, track, getWidth(), velocityX,
                        minimumFlingVelocity, rejected || event.getActionMasked() == MotionEvent.ACTION_CANCEL);
                dragging = false;
                settleVelocity = velocityX;
                recycleVelocity();
                if (target == PagerState.Page.HOME) hideKeyboard();
                animateTo(target);
                return true;
            default:
                return true;
        }
    }

    private void animateTo(PagerState.Page target) {
        cancelAnimation();
        float end = PagerState.endpoint(target, getWidth());
        float velocityX = settleVelocity;
        settleVelocity = 0;
        if (track == end || !Motion.enabled()) {
            finishAt(target);
            return;
        }
        FloatValueHolder holder = new FloatValueHolder(track);
        animation = Motion.spring(holder, track, end, velocityX,
                (a, value, velocity) -> applyTrack(value),
                (a, canceled, value, velocity) -> {
                    if (animation == a && !canceled) finishAt(target);
                });
    }

    private void finishAt(PagerState.Page target) {
        animation = null;
        page = target;
        applyTrack(PagerState.endpoint(page, getWidth()));
        applyAccessibility();
        if (page == PagerState.Page.HOME) { hideKeyboard(); requestFocus(); }
        listener.onPageChanged(page);
    }

    private void applyTrack(float value) {
        track = PagerState.clamp(value, getWidth());
        chat.setTranslationX(track - getWidth());
        if (home != null) home.setTranslationX(track);
    }

    private void applyAccessibility() {
        chat.setImportantForAccessibility(page == PagerState.Page.CHAT
                ? View.IMPORTANT_FOR_ACCESSIBILITY_AUTO : View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        if (home != null) home.setImportantForAccessibility(page == PagerState.Page.HOME
                ? View.IMPORTANT_FOR_ACCESSIBILITY_AUTO : View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
    }

    private void hideKeyboard() {
        chat.clearFocus();
        android.view.inputmethod.InputMethodManager input = getContext().getSystemService(
                android.view.inputmethod.InputMethodManager.class);
        if (input != null) input.hideSoftInputFromWindow(chat.getWindowToken(), 0);
    }

    private void cancelAnimation() {
        if (animation == null) return;
        SpringAnimation current = animation;
        animation = null;
        current.cancel();
    }

    private void recycleVelocity() {
        if (velocity != null) velocity.recycle();
        velocity = null;
    }
}
