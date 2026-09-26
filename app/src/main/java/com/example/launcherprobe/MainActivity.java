package com.example.launcherprobe;

import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Bundle;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebView;
import android.widget.Toast;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

import org.json.JSONObject;

import java.lang.ref.WeakReference;

/** Ordinary assistant entry; execution and drafts belong to the process-owned coordinator. */
public class MainActivity extends BridgeActivity {
    public static final String EXTRA_NEW_CHAT = "assistant_new_chat";
    public static final String EXTRA_OPEN_ARCHIVED = "assistant_open_archived";
    private static final String ROUTE_KEY = "web_route";
    private static final String ENTRY_CONSUMED_KEY = "assistant_entry_consumed";
    private static final String ARCHIVED_PROMPT_KEY = "assistant_archived_prompt";
    private static WeakReference<MainActivity> resumedActivity = new WeakReference<>(null);

    private ChatCoordinator chatCoordinator;
    private ChatStore chatStore;
    private WebView chatWebView;
    private volatile String initialWebRoute;
    private String pendingRoute;
    private String pendingArchivedId;
    private String pendingUndoId;
    private String pendingError;
    private String appearanceRevision;
    private boolean creating = true;
    private boolean uiReady;
    private boolean webReady;
    private boolean archivePromptShown;

    /** The resumed assistant, if any; wake-word input may present its listening panel here. */
    static MainActivity resumed() { return resumedActivity.get(); }

    @Override protected void attachBaseContext(Context base) { super.attachBaseContext(UiText.wrap(base)); }

    @Override public void onCreate(Bundle savedInstanceState) {
        chatCoordinator = ChatCoordinator.get(this);
        chatStore = chatCoordinator.store();
        initialWebRoute = savedInstanceState == null ? "/chat/" + Uri.encode(chatStore.activeId())
                : savedInstanceState.getString(ROUTE_KEY, "/chat/" + Uri.encode(chatStore.activeId()));
        pendingRoute = initialWebRoute;
        boolean consumed = savedInstanceState != null && savedInstanceState.getBoolean(ENTRY_CONSUMED_KEY);
        if (consumed) {
            pendingArchivedId = savedInstanceState.getString(ARCHIVED_PROMPT_KEY);
            clearEntryExtras(getIntent());
        } else {
            // Device.state() can run while BridgeActivity creates the WebView: establish its route first.
            consumeIntent(getIntent());
        }
        registerPlugin(ChatPlugin.class);
        registerPlugin(ScheduledTasksPlugin.class);
        registerPlugin(SettingsPlugin.class);
        registerPlugin(DevicePlugin.class);
        bridgeBuilder.addWebViewListener(new WebViewListener() {
            @Override public void onPageStarted(WebView view) { webReady = false; }
            @Override public void onPageLoaded(WebView view) {
                webReady = trustedWebUrl(view.getUrl());
                applyPendingRoute();
            }
        });
        super.onCreate(savedInstanceState);
        creating = false;
        AppAppearance appearance = AppAppearance.read(this);
        appearanceRevision = AppAppearance.revision(this);
        appearance.apply(this);
        appearance.applySystemBars(this, appearance.surface);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        if (bridge != null) {
            chatWebView = bridge.getWebView();
            chatWebView.setBackgroundColor(appearance.background);
            chatWebView.getSettings().setTextZoom(Math.round(getResources().getConfiguration().fontScale * 100));
            // Keep Capacitor's parent and SystemBars listener: they own safe-area CSS and IME insets.
            chatWebView.requestApplyInsets();
            applyPendingRoute();
        }
        // Registers read-aloud for finished replies even before the first dictation.
        VoiceManager.get(this);
        uiReady = true;
        showPendingEntry();
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // BridgeActivity.load() forwards the original intent during super.onCreate().
        if (!creating) consumeIntent(intent);
    }

    private void consumeIntent(Intent intent) {
        if (intent == null) return;
        boolean openChat = intent.hasExtra(TaskDetailActivity.EXTRA_OPEN_CHAT);
        String conversationId = intent.getStringExtra(TaskDetailActivity.EXTRA_OPEN_CHAT);
        boolean newChat = intent.getBooleanExtra(EXTRA_NEW_CHAT, false);
        boolean archived = intent.getBooleanExtra(EXTRA_OPEN_ARCHIVED, false);
        String archivedId = intent.getStringExtra(TaskDetailActivity.EXTRA_ARCHIVED_ID);
        clearEntryExtras(intent);
        if (openChat) openChat(conversationId);
        else if (archived) {
            pendingArchivedId = null;
            archivePromptShown = false;
            launchWeb("/archived");
        } else if (newChat) {
            pendingArchivedId = null;
            archivePromptShown = false;
            try {
                chatStore.newAssistantConversation();
                launchWeb("/chat/" + Uri.encode(chatStore.activeId()));
            } catch (RuntimeException exception) { failure(exception); }
        }
        if (archivedId != null) pendingUndoId = archivedId;
        showPendingEntry();
    }

    private static void clearEntryExtras(Intent intent) {
        if (intent == null) return;
        intent.removeExtra(EXTRA_NEW_CHAT);
        intent.removeExtra(EXTRA_OPEN_ARCHIVED);
        intent.removeExtra(TaskDetailActivity.EXTRA_OPEN_CHAT);
        intent.removeExtra(TaskDetailActivity.EXTRA_ARCHIVED_ID);
    }

    @Override public void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        String visibleRoute = currentWebRoute();
        outState.putString(ROUTE_KEY, pendingRoute != null || visibleRoute == null ? initialWebRoute : visibleRoute);
        outState.putBoolean(ENTRY_CONSUMED_KEY, true);
        outState.putString(ARCHIVED_PROMPT_KEY, pendingArchivedId);
    }

    @Override public void onResume() {
        super.onResume();
        resumedActivity = new WeakReference<>(this);
        LegacyNavigationRecovery.recover(this);
        WakeWordService.sync(this);
        TaskWidgetProvider.requestRefresh(this, true);
        if (!AppAppearance.revision(this).equals(appearanceRevision)) { recreate(); return; }
        showPendingEntry();
        refreshWeb();
    }

    @Override public void onPause() {
        if (resumedActivity.get() == this) resumedActivity.clear();
        super.onPause();
    }

    @Override public void onDestroy() {
        if (resumedActivity.get() == this) resumedActivity.clear();
        VoiceManager.get(this).cancelListening();
        super.onDestroy();
    }

    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        if (chatWebView != null) chatWebView.getSettings().setTextZoom(Math.round(configuration.fontScale * 100));
    }

    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused) refreshWeb();
    }

    private boolean trustedWebUrl(String value) {
        if (value == null || bridge == null) return false;
        Uri expected = Uri.parse(bridge.getLocalUrl());
        Uri actual = Uri.parse(value);
        return expected.getScheme() != null && expected.getScheme().equals(actual.getScheme())
                && expected.getAuthority() != null && expected.getAuthority().equals(actual.getAuthority());
    }

    private String currentWebRoute() {
        String url = chatWebView == null ? null : chatWebView.getUrl();
        if (!trustedWebUrl(url)) return null;
        String route = Uri.parse(url).getFragment();
        return route != null && route.startsWith("/") && !route.startsWith("//") ? route : null;
    }

    boolean isTaskConversationVisible(String conversationId) {
        if (resumed() != this || !hasWindowFocus() || !webReady || pendingRoute != null
                || conversationId == null || !conversationId.equals(chatStore.activeId())) return false;
        String route = currentWebRoute();
        if (route == null) return false;
        route = route.split("\\?", 2)[0];
        return route.equals("/chat") || route.equals("/chat/" + conversationId);
    }

    String launchRoute() { return initialWebRoute == null ? "/chat" : initialWebRoute; }

    public void openChat(String conversationId) {
        pendingArchivedId = null;
        archivePromptShown = false;
        try {
            if (conversationId == null || conversationId.isEmpty()) {
                // An empty voice return is a fresh conversation, not consumption of the migration draft.
                chatStore.newConversation();
                launchWeb("/chat/" + Uri.encode(chatStore.activeId()));
            } else if (chatStore.isArchived(conversationId)) {
                pendingArchivedId = conversationId;
                showPendingEntry();
            } else selectAndOpen(conversationId);
        } catch (RuntimeException exception) { failure(exception); }
    }

    private void selectAndOpen(String conversationId) {
        // The currently open, still-empty conversation need not have an index entry yet.
        if (!conversationId.equals(chatStore.activeId())) chatStore.selectConversation(conversationId);
        launchWeb("/chat/" + Uri.encode(conversationId));
    }

    public void openTaskDetail(String conversationId) {
        startActivity(new Intent(this, TaskDetailActivity.class)
                .putExtra(TaskDetailActivity.EXTRA_CONVERSATION_ID, conversationId));
    }

    public void openAssistantSettings() { launchWeb("/settings"); }

    private void launchWeb(String route) {
        initialWebRoute = route;
        pendingRoute = route;
        applyPendingRoute();
    }

    private void applyPendingRoute() {
        if (!webReady || chatWebView == null || !trustedWebUrl(chatWebView.getUrl())) return;
        if (pendingRoute != null) {
            String route = pendingRoute;
            chatWebView.evaluateJavascript("location.hash=" + JSONObject.quote("#" + route)
                    + ";window.dispatchEvent(new Event('native-navigation'));true", applied -> {
                        // Keep the route through recreation until the WebView has actually applied it.
                        if ("true".equals(applied) && route.equals(pendingRoute)
                                && trustedWebUrl(chatWebView.getUrl())) pendingRoute = null;
                    });
        }
    }

    private void refreshWeb() {
        applyPendingRoute();
        if (webReady && chatWebView != null && trustedWebUrl(chatWebView.getUrl()))
            chatWebView.evaluateJavascript("window.dispatchEvent(new Event('native-navigation'))", null);
    }

    private void showPendingEntry() {
        if (!uiReady || isFinishing() || isDestroyed()) return;
        if (pendingError != null) {
            Toast.makeText(this, UiText.get(this, pendingError), Toast.LENGTH_LONG).show();
            pendingError = null;
        }
        if (pendingArchivedId != null && !archivePromptShown) {
            String id = pendingArchivedId;
            archivePromptShown = true;
            if (chatStore.isArchived(id)) {
                ConversationArchiveUi.promptArchived(this, chatStore.archivedAt(id),
                        () -> resolveArchived(id, true), () -> resolveArchived(id, false));
            } else resolveArchived(id, false);
        }
        if (pendingUndoId != null) {
            String id = pendingUndoId;
            pendingUndoId = null;
            ViewGroup root = findViewById(android.R.id.content);
            ConversationArchiveUi.showUndo(root, UiText.get(this, "对话已归档"), () -> {
                try { chatCoordinator.restoreConversation(id); refreshWeb(); }
                catch (RuntimeException exception) { failure(exception); }
            }, this);
        }
    }

    private void resolveArchived(String id, boolean restore) {
        // A newer external entry must not be replaced by an older prompt's callback.
        if (!id.equals(pendingArchivedId)) return;
        pendingArchivedId = null;
        archivePromptShown = false;
        try {
            if (restore) chatCoordinator.restoreConversation(id);
            selectAndOpen(id);
        } catch (RuntimeException exception) { failure(exception); }
    }

    private void failure(RuntimeException exception) {
        pendingError = exception.getMessage() == null ? exception.toString() : exception.getMessage();
        showPendingEntry();
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        VoiceManager.get(this).onRequestPermissionsResult(this, request, results);
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        VoiceManager.get(this).onActivityResult(request, result, data);
    }
}
