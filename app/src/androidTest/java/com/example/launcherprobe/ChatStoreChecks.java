package com.example.launcherprobe;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;

import java.util.Arrays;
import java.util.Collections;

/** Store checks use test-package preferences; the target-Activity UI check is read-only. */
public final class ChatStoreChecks extends Instrumentation {
    private boolean storageOnly;

    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        storageOnly = arguments != null && "store".equals(arguments.getString("checks"));
        start();
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            checkConversations();
            checkTreePersistence();
            checkMarkdown();
            if (!storageOnly) {
                checkStationaryComposer();
                checkPiStreaming();
            }
            result.putString("stream", storageOnly
                    ? "PASS: conversations, tree migration and branches, drafts, incomplete full long content; Markdown, math delimiters, code isolation and links\n"
                    : "PASS: conversations and drafts; composer identity; streaming bubble identity, no animation reset, Markdown and final actions\n");
            finish(Activity.RESULT_OK, result);
        } catch (Throwable failure) {
            result.putString("stream", "FAIL: " + android.util.Log.getStackTraceString(failure));
            finish(Activity.RESULT_CANCELED, result);
        }
    }

    private void checkTreePersistence() {
        Context context = getContext();
        SharedPreferences prefs = context.getSharedPreferences("chat", Context.MODE_PRIVATE);
        prefs.edit().clear().putString("history", "[{\"role\":\"user\",\"content\":\"old\"},{\"role\":\"assistant\",\"content\":\"answer\"}]").commit();
        ChatStore store = new ChatStore(context);
        java.util.List<AgentLoop.Message> shared = store.load();
        String sharedId = shared.get(1).id;
        require(new ChatStore(context).load().get(1).id.equals(sharedId), "legacy migration gives stable message IDs");
        AgentLoop.Message first = new AgentLoop.Message("user", "first branch");
        java.util.List<AgentLoop.Message> branch = new java.util.ArrayList<>(shared);
        branch.add(first); store.save(branch);
        store.selectNode(sharedId);
        AgentLoop.Message second = new AgentLoop.Message("user", "second branch");
        branch = new java.util.ArrayList<>(store.load()); branch.add(second); store.save(branch);
        ChatStore reopened = new ChatStore(context);
        require(reopened.tree().nodes().size() == 4 && reopened.load().get(2).id.equals(second.id), "restart retains both branches and active leaf");
        reopened.selectNode(first.id);
        require(reopened.load().get(2).content.equals("first branch"), "old continuation still navigable");
        AgentLoop.Message partial = new AgentLoop.Message("assistant", "partial", null, Collections.emptyList(), true);
        branch = new java.util.ArrayList<>(reopened.load()); branch.add(partial); reopened.save(branch);
        branch.set(branch.size() - 1, new AgentLoop.Message(partial.id, "assistant", "partial complete", null, Collections.emptyList(), false));
        reopened.save(branch);
        require(reopened.tree().nodes().size() == 5 && !reopened.load().get(3).incomplete, "partial update replaces one node without phantom branch");
        String previousConversation = reopened.activeId();
        reopened.selectNode(null);
        require(reopened.load().isEmpty() && !reopened.tree().nodes().isEmpty(), "editing root leaves an empty path but a nonempty conversation");
        reopened.newConversation();
        require(!reopened.activeId().equals(previousConversation) && reopened.load().isEmpty(), "new conversation after root edit changes identity");
        reopened.selectConversation(previousConversation);
        require(reopened.tree().nodes().size() == 5, "new conversation leaves the previous tree intact");
        prefs.edit().clear().commit();
    }

    private void checkMarkdown() {
        Throwable[] error = new Throwable[1];
        runOnMainSync(() -> {
            try {
                io.noties.markwon.Markwon renderer = ResponseMarkdown.create(getTargetContext(), uri -> {});
                android.widget.TextView view = new android.widget.TextView(getTargetContext());
                view.setTextIsSelectable(true);
                String source = "# Heading\n\n**bold** and *italic* and ~~removed~~\n\n- item\n- [x] done\n\n"
                        + "```text\n\\(literal\\) $code$\n```\n\n`\\(inline-code\\) $code$`\n\n"
                        + "| A | B |\n| --- | --- |\n| 1 | 2 |\n\n"
                        + "Inline \\(x^2\\), $y^2$ and $$z^2$$.\n\n\\[\\frac{1}{2}\\]\n\n"
                        + "$$\n\\boxed{x=1}\n$$\n\n[site](https://example.com)\n\nCost $5 and $10.";
                renderer.setMarkdown(view, source);
                android.text.Spanned text = (android.text.Spanned) view.getText();
                require(!text.toString().contains("# Heading") && !text.toString().contains("**bold**"),
                        "Markdown syntax is rendered");
                require(text.toString().contains("\\(literal\\) $code$") && text.toString().contains("\\(inline-code\\) $code$")
                        && text.toString().contains("Cost $5 and $10."),
                        "code and currency are not rewritten as math");
                io.noties.markwon.image.AsyncDrawableSpan[] math = text.getSpans(0, text.length(),
                        io.noties.markwon.image.AsyncDrawableSpan.class);
                require(math.length == 5, "all five inline/block math delimiter forms create drawable spans: " + math.length);
                for (io.noties.markwon.image.AsyncDrawableSpan span : math) {
                    span.getDrawable().setResult(ru.noties.jlatexmath.JLatexMathDrawable
                            .builder(span.getDrawable().getDestination()).textSize(32).build());
                }
                java.util.Set<String> spans = new java.util.HashSet<>();
                for (Object span : text.getSpans(0, text.length(), Object.class)) spans.add(span.getClass().getSimpleName());
                require(spans.contains("TableRowSpan") && spans.contains("CodeBlockSpan"), "tables and fenced code are rendered: " + spans);
                require(view.getMovementMethod() instanceof android.text.method.LinkMovementMethod,
                        "links remain interactive on selectable text");
                require(ResponseMarkdown.isWebLink("https://example.com") && !ResponseMarkdown.isWebLink("intent://app")
                        && !ResponseMarkdown.isWebLink("file:///tmp/x") && !ResponseMarkdown.isWebLink("javascript:alert(1)"),
                        "model links accept only web URLs");
                renderer.setMarkdown(view, source + "\n\nMore streamed text.");
                android.text.Spanned updated = (android.text.Spanned) view.getText();
                io.noties.markwon.image.AsyncDrawableSpan[] updatedMath = updated.getSpans(0, updated.length(),
                        io.noties.markwon.image.AsyncDrawableSpan.class);
                require(updatedMath.length == math.length, "stream retains all formulas");
                for (int i = 0; i < math.length; i++) require(updatedMath[i].getDrawable().getResult()
                        == math[i].getDrawable().getResult(), "completed formula drawable reused during streaming");
                renderer.setMarkdown(view, "Unfinished \\(x^");
                require(view.getText().toString().contains("x^"), "unfinished formula remains visible");
                char[] longText = new char[5001];
                Arrays.fill(longText, 'x');
                renderer.setMarkdown(view, new String(longText));
                require(view.getText().length() == longText.length, "rendering does not truncate long replies");
            } catch (Throwable failure) { error[0] = failure; }
        });
        if (error[0] != null) throw new AssertionError("Markdown rendering", error[0]);
    }

    private void checkConversations() {
        Context context = getContext();
        SharedPreferences prefs = context.getSharedPreferences("chat", Context.MODE_PRIVATE);
        prefs.edit().clear().putString("history", "[{\"role\":\"user\",\"content\":\"旧对话\"}]")
                .putString("api_key", "test-only-key").commit();
        ChatStore store = new ChatStore(context);
        require(store.conversations().size() == 1, "legacy indexed");
        require(store.load().get(0).content.equals("旧对话"), "legacy transcript preserved");
        require(!store.load().get(0).incomplete, "legacy messages default to complete");
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
        store.newConversation();
        char[] longText = new char[50_001];
        Arrays.fill(longText, 'x');
        store.save(Arrays.asList(new AgentLoop.Message("user", "partial reply"),
                new AgentLoop.Message("assistant", new String(longText), null, Collections.emptyList(), true)));
        store = new ChatStore(context);
        require(store.load().get(1).incomplete && store.load().get(1).content.equals(new String(longText)),
                "incomplete flag and complete long reply survive serialization without truncation");
        prefs.edit().clear().commit();
    }

    private void checkStationaryComposer() {
        MainActivity activity = (MainActivity) startActivitySync(new android.content.Intent(
                getTargetContext(), MainActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
        waitForIdleSync();
        android.view.View[] dock = new android.view.View[1];
        android.widget.EditText[] input = new android.widget.EditText[1];
        runOnMainSync(() -> {
            dock[0] = (android.view.View) field(activity, "composerDock");
            input[0] = (android.widget.EditText) field(activity, "composerInput");
            android.view.View wallpaper = (android.view.View) field(activity, "homeWallpaper");
            android.view.View pageShell = (android.view.View) field(activity, "pageShell");
            android.view.ViewGroup root = (android.view.ViewGroup) field(activity, "root");
            require(wallpaper.getVisibility() == android.view.View.VISIBLE,
                    "home wallpaper visible behind composer");
            require(wallpaper.getLeft() == pageShell.getLeft()
                    && wallpaper.getTop() == pageShell.getTop()
                    && wallpaper.getRight() == pageShell.getRight()
                    && wallpaper.getBottom() == pageShell.getBottom(),
                    "home wallpaper covers padded page shell");
            int[] wallpaperLocation = new int[2];
            int[] dockLocation = new int[2];
            wallpaper.getLocationOnScreen(wallpaperLocation);
            dock[0].getLocationOnScreen(dockLocation);
            require(dockLocation[0] >= wallpaperLocation[0]
                    && dockLocation[1] >= wallpaperLocation[1]
                    && dockLocation[0] + dock[0].getWidth()
                            <= wallpaperLocation[0] + wallpaper.getWidth()
                    && dockLocation[1] + dock[0].getHeight()
                            <= wallpaperLocation[1] + wallpaper.getHeight(),
                    "home wallpaper covers composer");
            require(root.indexOfChild(wallpaper) < root.indexOfChild(pageShell),
                    "wallpaper is behind shell");
            require(input[0].getShowSoftInputOnFocus(), "home input allows soft keyboard");
            long time = android.os.SystemClock.uptimeMillis();
            android.view.MotionEvent down = android.view.MotionEvent.obtain(time, time,
                    android.view.MotionEvent.ACTION_DOWN, input[0].getWidth() / 2f, input[0].getHeight() / 2f, 0);
            android.view.MotionEvent up = android.view.MotionEvent.obtain(time, time + 60,
                    android.view.MotionEvent.ACTION_UP, input[0].getWidth() / 2f, input[0].getHeight() / 2f, 0);
            input[0].dispatchTouchEvent(down);
            input[0].dispatchTouchEvent(up);
            down.recycle();
            up.recycle();
            require("home".equals(field(activity, "page")), "home input touch stays home");
            require(input[0].hasFocus(), "home input touch focuses editor");
            invoke(activity, "showSearch");
        });
        waitForIdleSync();
        runOnMainSync(() -> {
            require(field(activity, "composerInput") == input[0], "input identity retained");
            require(field(activity, "composerDock") == dock[0], "dock identity retained");
            require(dock[0].getTranslationY() == 0 && dock[0].getAlpha() == 1f,
                    "page animation excludes dock");
            activity.onBackPressed();
            input[0].performClick();
            require("home".equals(field(activity, "page")), "home input click stays home");
            require(((android.view.ViewGroup) field(activity, "contentStage")).getChildCount() == 1,
                    "rapid navigation leaves only one page");
            activity.finish();
        });
    }

    /** UI-only fixture: no model request, provider change, or target preference write. */
    private void checkPiStreaming() {
        MainActivity activity = (MainActivity) startActivitySync(new android.content.Intent(
                getTargetContext(), MainActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
        waitForIdleSync();
        runOnMainSync(() -> {
            Object original = field(activity, "history");
            try {
                invoke(activity, "showSearch");
                java.lang.reflect.Field running = MainActivity.class.getDeclaredField("agentRunning");
                java.lang.reflect.Field request = MainActivity.class.getDeclaredField("activePiRequestId");
                running.setAccessible(true); request.setAccessible(true);
                running.set(activity, true); request.set(activity, "streaming-view-check");
                java.lang.reflect.Field messageId = MainActivity.class.getDeclaredField("activePiMessageId");
                messageId.setAccessible(true); messageId.set(activity, "streaming-message-check");
                java.lang.reflect.Method preview = MainActivity.class.getDeclaredMethod(
                        "updatePiPreview", java.util.List.class, String.class);
                preview.setAccessible(true);
                java.util.List<AgentLoop.Message> work = Collections.singletonList(
                        new AgentLoop.Message("user", "stream fixture"));
                String text = "# Heading\n**bold**";
                preview.invoke(activity, work, text);
                android.widget.TextView body = (android.widget.TextView) field(activity, "piStreamingBody");
                android.view.ViewGroup bubble = (android.view.ViewGroup) body.getParent();
                android.view.ViewGroup list = (android.view.ViewGroup) field(activity, "messageList");
                android.view.View user = list.getChildAt(0);
                bubble.animate().cancel();
                bubble.setAlpha(1f);
                require(bubble.getChildCount() == 1, "stream has no stale copy/share actions");
                for (int index = 0; index < 100; index++) {
                    text += "\nline " + index;
                    preview.invoke(activity, work, text);
                    require(field(activity, "piStreamingBody") == body, "stream reuses text view");
                    require(body.getParent() == bubble && list.getChildAt(0) == user,
                            "stream does not rebuild bubbles or previous messages");
                    require(bubble.getAlpha() == 1f, "stream does not restart fade-in");
                }
                require(body.getText().toString().contains("line 99"), "all deltas visible");
                require(body.getText() instanceof android.text.Spanned
                        && ((android.text.Spanned) body.getText()).getSpans(0, body.length(),
                                io.noties.markwon.core.spans.StrongEmphasisSpan.class).length > 0, "stream retains Markdown spans");
                java.lang.reflect.Method finish = MainActivity.class.getDeclaredMethod(
                        "finishAgent", java.util.List.class, String.class);
                finish.setAccessible(true);
                finish.invoke(activity, Arrays.asList(work.get(0),
                        new AgentLoop.Message("assistant", text)), "done");
                require(field(activity, "piStreamingBody") == null, "final clears streaming reference");
                require(((android.view.ViewGroup) list.getChildAt(1)).getChildCount() == 2,
                        "final reply restores actions");
                finish.invoke(activity, original, "");
            } catch (ReflectiveOperationException exception) {
                throw new AssertionError(exception);
            } finally { activity.finish(); }
        });
    }

    private static void invoke(MainActivity activity, String name) {
        try {
            java.lang.reflect.Method method = MainActivity.class.getDeclaredMethod(name);
            method.setAccessible(true);
            method.invoke(activity);
        } catch (ReflectiveOperationException exception) {
            throw new AssertionError(exception);
        }
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
