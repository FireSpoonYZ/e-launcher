package com.example.launcherprobe;

import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Bundle;
import android.os.Looper;
import android.util.Log;
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
    public static final String EXTRA_OPEN_SCHEDULE = "assistant_open_schedule";
    public static final String EXTRA_OPEN_HOST = "assistant_open_host";
    private static final String ROUTE_KEY = "web_route";
    private static final String ENTRY_CONSUMED_KEY = "assistant_entry_consumed";
    private static final String ARCHIVED_PROMPT_KEY = "assistant_archived_prompt";
    private static WeakReference<MainActivity> resumedActivity = new WeakReference<>(null);

    private ChatCoordinator chatCoordinator;
    private ChatStore chatStore;
    private volatile boolean hostOnly;
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
    private String terminalPageToken;

    void setTerminalPage(String token, boolean active) {
        if (active) terminalPageToken = token;
        else if (token.equals(terminalPageToken)) terminalPageToken = null;
        applyWebTextZoom(getResources().getConfiguration());
    }

    private void applyWebTextZoom(Configuration configuration) {
        if (chatWebView != null) chatWebView.getSettings().setTextZoom(
                terminalTextZoom(terminalPageToken != null, configuration.fontScale));
    }

    static boolean isTerminalPageRoute(String route) {
        return route != null && route.matches("/terminals/[^/]+/[^/?]+(?:\\?.*)?");
    }

    static boolean isHostRoute(String route) {
        return route != null && (route.equals("/settings/host") || route.startsWith("/settings/host?"));
    }

    static int terminalTextZoom(boolean terminalPage, float fontScale) {
        return terminalPage ? 100 : Math.round(fontScale * 100);
    }

    /** The resumed assistant, if any; wake-word input may present its listening panel here. */
    static MainActivity resumed() { return resumedActivity.get(); }

    @Override protected void attachBaseContext(Context base) { super.attachBaseContext(UiText.wrap(base)); }

    @Override public void onCreate(Bundle savedInstanceState) {
        // A Host-only entry must not touch legacy chat business on the cold start chain.
        // Explicit entry extras win over a restored Host route; openHost keeps its consumeIntent precedence.
        String savedRoute = savedInstanceState == null ? null : savedInstanceState.getString(ROUTE_KEY);
        boolean intentHost = getIntent().getBooleanExtra(EXTRA_OPEN_HOST, false);
        boolean intentLegacy = getIntent().hasExtra(EXTRA_NEW_CHAT)
                || getIntent().hasExtra(EXTRA_OPEN_ARCHIVED)
                || getIntent().hasExtra(EXTRA_OPEN_SCHEDULE)
                || getIntent().hasExtra(TaskDetailActivity.EXTRA_OPEN_CHAT)
                || getIntent().hasExtra(TaskDetailActivity.EXTRA_ARCHIVED_ID);
        boolean savedHost = isHostRoute(savedRoute);
        // An explicit legacy entry must never be swallowed by a saved Host route.
        boolean hostConflict = savedHost && intentLegacy;
        hostOnly = intentHost || (savedHost && !intentLegacy);
        if (hostOnly) {
            initialWebRoute = intentHost ? "/settings/host" : savedRoute;
            pendingRoute = initialWebRoute;
            pendingArchivedId = null;
            archivePromptShown = false;
            clearEntryExtras(getIntent());
        } else {
            chatCoordinator = ChatCoordinator.get(this);
            chatStore = chatCoordinator.store();
            boolean consumed = savedInstanceState != null && savedInstanceState.getBoolean(ENTRY_CONSUMED_KEY);
            if (consumed && !hostConflict) {
                initialWebRoute = savedInstanceState.getString(ROUTE_KEY, "/chat/" + Uri.encode(chatStore.activeId()));
                pendingRoute = initialWebRoute;
                pendingArchivedId = savedInstanceState.getString(ARCHIVED_PROMPT_KEY);
                clearEntryExtras(getIntent());
            } else {
                // A fresh explicit entry wins over the saved route; Device.state() can run while
                // BridgeActivity creates the WebView, so establish its route before that.
                initialWebRoute = savedInstanceState == null ? "/chat/" + Uri.encode(chatStore.activeId())
                        : savedInstanceState.getString(ROUTE_KEY, "/chat/" + Uri.encode(chatStore.activeId()));
                pendingRoute = initialWebRoute;
                consumeIntent(getIntent());
            }
        }
        registerPlugin(ChatPlugin.class);
        registerPlugin(ScheduledTasksPlugin.class);
        registerPlugin(SettingsPlugin.class);
        registerPlugin(DevicePlugin.class);
        registerPlugin(RemoteTerminalPlugin.class);
        registerPlugin(BotHostPlugin.class);
        bridgeBuilder.addWebViewListener(new WebViewListener() {
            @Override public void onPageStarted(WebView view) {
                webReady = false;
                terminalPageToken = null;
                applyWebTextZoom(getResources().getConfiguration());
            }
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
            terminalPageToken = isTerminalPageRoute(initialWebRoute) ? "route-init" : null;
            applyWebTextZoom(getResources().getConfiguration());
            // Keep Capacitor's parent and SystemBars listener: they own safe-area CSS and IME insets.
            chatWebView.requestApplyInsets();
            applyPendingRoute();
        }
        // Registers read-aloud for finished replies even before the first dictation (legacy entries only).
        if (!hostOnly) VoiceManager.get(this);
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
        String taskId = intent.getStringExtra(EXTRA_OPEN_SCHEDULE);
        boolean openHost = intent.getBooleanExtra(EXTRA_OPEN_HOST, false);
        clearEntryExtras(intent);
        if (openHost) {
            pendingArchivedId = null;
            archivePromptShown = false;
            launchWeb("/settings/host");
        } else if (taskId != null) {
            pendingArchivedId = null;
            archivePromptShown = false;
            launchWeb("/schedules?taskId=" + Uri.encode(taskId));
        } else if (openChat) openChat(conversationId);
        else if (archived) {
            pendingArchivedId = null;
            archivePromptShown = false;
            launchWeb("/archived");
        } else if (newChat) {
            pendingArchivedId = null;
            archivePromptShown = false;
            try {
                store().newAssistantConversation();
                launchWeb("/chat/" + Uri.encode(store().activeId()));
            } catch (RuntimeException exception) { failure(exception); }
        }
        if (archivedId != null) pendingUndoId = archivedId;
        showPendingEntry();
    }

    private static void clearEntryExtras(Intent intent) {
        if (intent == null) return;
        intent.removeExtra(EXTRA_NEW_CHAT);
        intent.removeExtra(EXTRA_OPEN_ARCHIVED);
        intent.removeExtra(EXTRA_OPEN_SCHEDULE);
        intent.removeExtra(EXTRA_OPEN_HOST);
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
        if (!hostOnly) {
            WakeWordService.sync(this);
            TaskWidgetProvider.requestRefresh(this, true);
        }
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
        VoiceManager manager = VoiceManager.instanceIfPresent();
        if (manager != null) manager.cancelListening();
        super.onDestroy();
    }

    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        applyWebTextZoom(configuration);
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
                || conversationId == null) return false;
        String route = currentWebRoute();
        if (route == null) return false;
        route = route.split("\\?", 2)[0];
        if (!route.equals("/chat") && !route.equals("/chat/" + conversationId)) return false;
        // Consult legacy storage only when a legacy chat route is actually visible.
        return conversationId.equals(store().activeId());
    }

    private ChatCoordinator coordinator() {
        if (chatCoordinator == null) chatCoordinator = ChatCoordinator.get(this);
        return chatCoordinator;
    }

    private ChatStore store() {
        if (chatStore == null) chatStore = coordinator().store();
        return chatStore;
    }

    boolean hostOnly() { return hostOnly; }

    /**
     * First legacy business call after a Host-only entry: switch to legacy mode once.
     * Runs on the main thread so the flag flip and service start are single-threaded;
     * never starts foreground/microphone services after finish or while paused.
     */
    void resumeLegacyIfHost() {
        if (!hostOnly) return;
        if (Looper.myLooper() == Looper.getMainLooper()) resumeLegacyOnMain();
        else runOnUiThread(this::resumeLegacyOnMain);
    }

    private void resumeLegacyOnMain() {
        if (!hostOnly) return;
        hostOnly = false;
        if (isFinishing() || isDestroyed()) return;
        restoreLegacySchedules();
        if (resumed() != this) return; // Paused: the next onResume restores wake word/widget sync.
        WakeWordService.sync(this);
        TaskWidgetProvider.requestRefresh(this, true);
    }

    private void restoreLegacySchedules() {
        try { ScheduledTasks.get(this).restore(); }
        catch (Exception failure) { Log.w("ScheduledTasks", "Unable to restore schedules", failure); }
    }

    String launchRoute() { return initialWebRoute == null ? "/chat" : initialWebRoute; }

    public void openChat(String conversationId) {
        pendingArchivedId = null;
        archivePromptShown = false;
        try {
            if (conversationId == null || conversationId.isEmpty()) {
                // An empty voice return is a fresh conversation, not consumption of the migration draft.
                store().newConversation();
                launchWeb("/chat/" + Uri.encode(store().activeId()));
            } else if (store().isArchived(conversationId)) {
                pendingArchivedId = conversationId;
                showPendingEntry();
            } else selectAndOpen(conversationId);
        } catch (RuntimeException exception) { failure(exception); }
    }

    private void selectAndOpen(String conversationId) {
        // The currently open, still-empty conversation need not have an index entry yet.
        if (!conversationId.equals(store().activeId())) store().selectConversation(conversationId);
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
            if (store().isArchived(id)) {
                ConversationArchiveUi.promptArchived(this, store().archivedAt(id),
                        () -> resolveArchived(id, true), () -> resolveArchived(id, false));
            } else resolveArchived(id, false);
        }
        if (pendingUndoId != null) {
            String id = pendingUndoId;
            pendingUndoId = null;
            ViewGroup root = findViewById(android.R.id.content);
            ConversationArchiveUi.showUndo(root, UiText.get(this, "对话已归档"), () -> {
                try { coordinator().restoreConversation(id); refreshWeb(); }
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
            if (restore) coordinator().restoreConversation(id);
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
