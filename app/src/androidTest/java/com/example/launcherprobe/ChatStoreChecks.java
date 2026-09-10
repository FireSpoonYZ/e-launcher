package com.example.launcherprobe;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;

import java.util.Arrays;
import java.util.Collections;

/** Runs against isolated test-package preferences; never changes the user's chats or keys. */
public final class ChatStoreChecks extends Instrumentation {
    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        start();
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            checkConversations();
            checkStationaryComposer();
            result.putString("stream", "PASS: conversations and drafts; shared composer identity/bounds across home/chat and rapid navigation\n");
            finish(Activity.RESULT_OK, result);
        } catch (Throwable failure) {
            result.putString("stream", "FAIL: " + android.util.Log.getStackTraceString(failure));
            finish(Activity.RESULT_CANCELED, result);
        }
    }

    private void checkConversations() {
        Context context = getContext();
        SharedPreferences prefs = context.getSharedPreferences("chat", Context.MODE_PRIVATE);
        prefs.edit().clear().putString("history", "[{\"role\":\"user\",\"content\":\"旧对话\"}]")
                .putString("api_key", "test-only-key").commit();
        ChatStore store = new ChatStore(context);
        require(store.conversations().size() == 1, "legacy indexed");
        require(store.load().get(0).content.equals("旧对话"), "legacy transcript preserved");
        require(store.apiKey().equals("test-only-key"), "settings preserved");
        String legacy = store.activeId();
        store.saveDraft("旧会话草稿");
        store.newConversation();
        require(store.draft().isEmpty(), "drafts do not leak into new chat");
        require(store.load().isEmpty(), "new conversation empty");
        require(store.conversations().size() == 1, "empty chat not in history");
        store.save(Arrays.asList(new AgentLoop.Message("user", "周末计划"),
                new AgentLoop.Message("assistant", "出门散步")));
        String second = store.activeId();
        require(store.conversations().size() == 2, "two separate chats");
        store = new ChatStore(context);
        require(store.activeId().equals(second) && store.load().size() == 2, "restart restores selection");
        store.saveDraft("第二个草稿");
        store.selectConversation(legacy);
        require(store.draft().equals("旧会话草稿"), "draft survives switching and store recreation");
        require(store.load().size() == 1 && store.load().get(0).content.equals("旧对话"), "switch preserves old chat");
        store.selectConversation(second);
        require(store.draft().equals("第二个草稿"), "each chat owns its draft");
        store.clear();
        require(!prefs.contains("draft_" + second), "deleted chat draft removed");
        require(store.load().isEmpty() && store.conversations().size() == 1, "delete only selected chat");
        store.selectConversation(legacy);
        require(store.load().get(0).content.equals("旧对话"), "other chat survived deletion");
        store.newConversation();
        store.save(Collections.singletonList(new AgentLoop.Message("user", "another")));
        String key = "history_" + store.activeId();
        prefs.edit().putString(key, "not-json").commit();
        boolean reported = false;
        try { store.load(); } catch (IllegalStateException expected) { reported = true; }
        require(reported && prefs.getString(key, "").equals("not-json"), "corrupt data not silently deleted");
        prefs.edit().clear().commit();
    }

    private void checkStationaryComposer() {
        MainActivity activity = (MainActivity) startActivitySync(new android.content.Intent(
                getTargetContext(), MainActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
        waitForIdleSync();
        android.view.View[] dock = new android.view.View[1];
        android.widget.EditText[] input = new android.widget.EditText[1];
        int[] original = new int[2];
        runOnMainSync(() -> {
            dock[0] = (android.view.View) field(activity, "composerDock");
            input[0] = (android.widget.EditText) field(activity, "composerInput");
            dock[0].getLocationOnScreen(original);
            long time = android.os.SystemClock.uptimeMillis();
            android.view.MotionEvent down = android.view.MotionEvent.obtain(time, time,
                    android.view.MotionEvent.ACTION_DOWN, input[0].getWidth() / 2f, input[0].getHeight() / 2f, 0);
            android.view.MotionEvent up = android.view.MotionEvent.obtain(time, time + 60,
                    android.view.MotionEvent.ACTION_UP, input[0].getWidth() / 2f, input[0].getHeight() / 2f, 0);
            input[0].dispatchTouchEvent(down);
            input[0].dispatchTouchEvent(up);
            down.recycle();
            up.recycle();
            require("search".equals(field(activity, "page")), "home input touch opens chat");
        });
        waitForIdleSync();
        runOnMainSync(() -> {
            int[] current = new int[2];
            dock[0].getLocationOnScreen(current);
            require(field(activity, "composerInput") == input[0], "input identity retained");
            require(field(activity, "composerDock") == dock[0], "dock identity retained");
            require(Arrays.equals(original, current), "dock does not move during page change");
            require(dock[0].getTranslationY() == 0 && dock[0].getAlpha() == 1f,
                    "page animation excludes dock");
            activity.onBackPressed();
            input[0].performClick();
            activity.onBackPressed();
            require("home".equals(field(activity, "page")), "rapid navigation ends on home");
            require(((android.view.ViewGroup) field(activity, "contentStage")).getChildCount() == 1,
                    "rapid navigation leaves only one page");
        });
        waitForIdleSync();
        runOnMainSync(() -> {
            int[] current = new int[2];
            dock[0].getLocationOnScreen(current);
            require(Arrays.equals(original, current), "return keeps dock bounds");
            activity.finish();
        });
    }

    private static Object field(MainActivity activity, String name) {
        try {
            java.lang.reflect.Field field = MainActivity.class.getDeclaredField(name);
            field.setAccessible(true);
            return field.get(activity);
        } catch (ReflectiveOperationException exception) {
            throw new AssertionError(exception);
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
