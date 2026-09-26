package com.example.launcherprobe;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;

import java.util.Arrays;
import java.util.Collections;

/** Store checks use test-package preferences; opt-in integration checks clean up temporary conversations. */
public final class ChatStoreChecks extends Instrumentation {
    private boolean storageOnly;
    private boolean npmOnly;
    private boolean questionnaireOnly;
    private boolean showerPreviewOnly;
    private boolean workbenchOnly;
    private String featureCheck;
    private String artifactDir;

    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        artifactDir = arguments == null ? null : arguments.getString("artifactDir");
        featureCheck = arguments == null ? "" : arguments.getString("checks", "");
        storageOnly = arguments != null && "store".equals(arguments.getString("checks"));
        npmOnly = arguments != null && "npm".equals(arguments.getString("checks"));
        questionnaireOnly = arguments != null && "questionnaire".equals(arguments.getString("checks"));
        showerPreviewOnly = arguments != null && "shower-preview".equals(arguments.getString("checks"));
        workbenchOnly = arguments != null && "workbench".equals(arguments.getString("checks"));
        start();
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            if ("share-intake".equals(featureCheck) || "share-ui".equals(featureCheck) || "notifications".equals(featureCheck)
                    || "voice-continuity".equals(featureCheck) || "search-consistency".equals(featureCheck)) {
                result.putString("stream", ("share-intake".equals(featureCheck)
                        ? ShareIntakeChecks.run(this) : FeatureAcceptanceChecks.run(this, featureCheck)) + "\n");
                finish(Activity.RESULT_OK, result);
                return;
            }
            if ("widget".equals(featureCheck)) {
                result.putString("stream", TaskWidgetChecks.run(this) + "\n");
                finish(Activity.RESULT_OK, result);
                return;
            }
            if (workbenchOnly) {
                result.putString("stream", WorkbenchChecks.run(this) + "\n");
                finish(Activity.RESULT_OK, result);
                return;
            }
            if (showerPreviewOnly) {
                result.putString("stream", ShowerPreviewChecks.run(this) + "\n");
                finish(Activity.RESULT_OK, result);
                return;
            }
            if (questionnaireOnly) {
                result.putString("stream", HomeQuestionnaireChecks.run(this) + "\n");
                finish(Activity.RESULT_OK, result);
                return;
            }
            if (npmOnly) {
                ActivityMonitor monitor = addMonitor(MainActivity.class.getName(), null, false);
                try (android.os.ParcelFileDescriptor launch = getUiAutomation(android.app.UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
                        .executeShellCommand("am start -W -n com.example.launcherprobe/.MainActivity");
                        java.io.InputStream output = new android.os.ParcelFileDescriptor.AutoCloseInputStream(launch)) {
                    output.readNBytes(4096);
                }
                Activity foreground = monitor.waitForActivityWithTimeout(15000);
                removeMonitor(monitor);
                if (foreground == null) throw new AssertionError("Could not foreground the test application");
                runOnMainSync(() -> foreground.getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON));
                result.putString("stream", NpmRuntimeChecks.run(getTargetContext(), getContext()) + "\n");
                finish(Activity.RESULT_OK, result);
                return;
            }
            PiConfigChecks.run(getContext());
            checkConversations();
            checkTreePersistence();
            checkPiContexts();
            checkMarkdown();
            if (!storageOnly) {
                checkAssistantEntryAndBackgroundPersistence();
            }
            result.putString("stream", storageOnly
                    ? "PASS: conversations, tree migration and branches, drafts, incomplete full long content; Markdown, math delimiters, code isolation and links\n"
                    : "PASS: conversations and drafts; ordinary Capacitor entry; coordinator stream persistence without Activity; Markdown\n");
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

    private void checkPiContexts() throws Exception {
        Context context = getContext();
        ChatStore store = new ChatStore(context);
        store.newConversation();
        org.json.JSONArray nativeMessages = new org.json.JSONArray("[{\"role\":\"toolResult\",\"toolCallId\":\"read-1\",\"content\":[{\"type\":\"text\",\"text\":\"kept\"}]}]");
        store.savePiContext("first", nativeMessages);
        store.savePiContext("second", new org.json.JSONArray());
        require(new ChatStore(context).piContext("first").equals(nativeMessages.toString()), "native tool context survives reopening");
        require(store.piContext("second").equals("[]") && store.piContext("missing") == null, "branches have independent native context");
        java.io.File directory = new java.io.File(new java.io.File(context.getFilesDir(), "pi-contexts"),
                java.util.UUID.nameUUIDFromBytes(store.activeId().getBytes(java.nio.charset.StandardCharsets.UTF_8)).toString());
        store.clear();
        require(!directory.exists(), "clearing chat removes native snapshots");
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

    /** Synthetic Pi events exercise the real coordinator/persistence path without starting Node. */
    private void checkAssistantEntryAndBackgroundPersistence() throws Exception {
        Context context = getTargetContext();
        ChatCoordinator coordinator = ChatCoordinator.get(context);
        ChatStore store = coordinator.store();
        String previous = store.activeId();
        String id = java.util.UUID.randomUUID().toString();
        AgentLoop.Message user = new AgentLoop.Message("user", "instrumentation stream fixture");
        store.save(id, Collections.singletonList(user));
        MainActivity activity = (MainActivity) startActivitySync(new android.content.Intent(context, MainActivity.class)
                .putExtra(TaskDetailActivity.EXTRA_OPEN_CHAT, id)
                .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
        java.util.concurrent.CountDownLatch completed = new java.util.concurrent.CountDownLatch(1);
        ChatCoordinator.Listener listener = (messages, event) -> {
            if (id.equals(event.optString("conversationId")) && "end".equals(event.optString("type"))) completed.countDown();
        };
        ChatCoordinator.SessionRun[] run = {null};
        try {
            waitForIdleSync();
            runOnMainSync(() -> {
                require(activity.getBridge() != null && activity.getBridge().getWebView() != null,
                        "ordinary assistant entry owns a Capacitor WebView");
                require(activity.launchRoute().equals("/chat/" + id), "explicit conversation route retained");
                require(id.equals(store.activeId()), "entry selects exact conversation");
                require(activity.getIntent().getCategories() == null
                        || !activity.getIntent().getCategories().contains(android.content.Intent.CATEGORY_HOME),
                        "entry does not request HOME");
                coordinator.addListener(listener);
                run[0] = coordinator.registerRun(id, null);
                run[0].persistence = new PiTurnPersistence(store, id, user.id, "fixture-" + run[0].requestId,
                        Collections.singletonList(user));
                activity.finish();
            });
            waitForIdleSync();
            runOnMainSync(() -> {
                require(activity.isFinishing(), "Activity is no longer the task owner");
                try {
                    for (int index = 0; index < 100; index++) coordinator.onPiEvent(new org.json.JSONObject()
                            .put("type", "text_delta").put("delta", "line " + index + "\n"), run[0]);
                    coordinator.onPiEvent(new org.json.JSONObject().put("type", "end").put("status", "completed"), run[0]);
                } catch (Exception exception) { throw new AssertionError(exception); }
            });
            require(completed.await(10, java.util.concurrent.TimeUnit.SECONDS), "coordinator broadcasts terminal event without Activity");
            ChatStore reopened = new ChatStore(context);
            java.util.List<AgentLoop.Message> messages = reopened.load(id);
            require(messages.size() == 2 && !messages.get(1).incomplete, "one complete assistant node survives reopening");
            StringBuilder expected = new StringBuilder();
            for (int index = 0; index < 100; index++) expected.append("line ").append(index).append('\n');
            require(expected.toString().equals(messages.get(1).content), "all deltas persisted exactly once");
            require(!coordinator.running(id) && "completed".equals(coordinator.taskCard(id).optString("runStatus")),
                    "terminal state remains available to details and Widget");
        } finally {
            coordinator.removeListener(listener);
            runOnMainSync(() -> {
                if (run[0] != null && coordinator.running(id)) coordinator.finish(run[0], "aborted", "fixture cleanup");
                activity.finish();
            });
            coordinator.deleteConversation(id);
            if (store.conversations().stream().anyMatch(item -> previous.equals(item.id))) store.selectConversation(previous);
        }
    }

    /** Explicit device-side output path; pull artifacts to a host directory outside the repository. */
    static java.io.File artifacts(Instrumentation test) throws java.io.IOException {
        String path = ((ChatStoreChecks) test).artifactDir;
        if (path == null || !new java.io.File(path).isAbsolute()) {
            throw new IllegalArgumentException("Pass -e artifactDir <absolute writable device directory>; pull evidence outside the repository");
        }
        java.io.File directory = new java.io.File(path).getCanonicalFile();
        if (!directory.isDirectory() && !directory.mkdirs()) throw new java.io.IOException("Cannot create artifactDir: " + directory);
        return directory;
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
