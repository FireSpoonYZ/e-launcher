package com.example.launcherprobe;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ApplicationInfo;
import android.content.pm.LauncherApps;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.inputmethod.InputMethodManager;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;
import org.json.JSONArray;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private int IVORY, CHARCOAL, TEAL, MUTED;
    private AppAppearance appearance;
    private String appearanceRevision;
    private static final String PAGE_KEY = "page";
    private static final String QUERY_KEY = "query";
    private static final String DRAFT_KEY = "chat_draft";
    private static final String CHAT_SCROLL_KEY = "chat_scroll";
    private static final String EXPANDED_TOOLS_KEY = "expanded_tools";
    private static final RunEpoch ACTIVITY_EPOCH = new RunEpoch();
    private static java.lang.ref.WeakReference<MainActivity> resumedActivity = new java.lang.ref.WeakReference<>(null);

    /** The visible launcher, if any; the wake word flow shows its listening panel here. */
    static MainActivity resumed() { return resumedActivity.get(); }

    private final Handler clockHandler = new Handler(Looper.getMainLooper());
    private final Runnable clockTick = new Runnable() {
        @Override public void run() {
            updateClock();
            clockHandler.postDelayed(this, 60_000 - System.currentTimeMillis() % 60_000);
        }
    };
    private ShizukuRepair shizukuRepair;
    private LauncherShortcuts launcherShortcuts;
    private HomeLayout homeLayout;
    private HomeDesktop homeDesktop;
    private NativeSearchPage nativeSearchPage;
    private NativeSearchPage.Mode searchMode;
    private boolean searchClosing;
    private androidx.dynamicanimation.animation.SpringAnimation searchSpring;
    private long desktopRevision;
    private AppAppearance desktopAppearance;
    private boolean desktopSettingsRegistered;
    private final android.content.BroadcastReceiver desktopSettingsChanged = new android.content.BroadcastReceiver() {
        @Override public void onReceive(android.content.Context context, Intent intent) {
            if (desktopRevision != new DesktopPreferences(MainActivity.this).revision()) recreate();
        }
    };
    private boolean shortcutListenerRegistered;
    private boolean packageReceiverRegistered;
    private final List<ResolveInfo> apps = new ArrayList<>();
    private FrameLayout root;
    private PagerRoot pager;
    private android.webkit.WebView chatWebView;
    private String initialWebRoute;
    private volatile boolean trustedWebContent;
    private View homeWallpaper;
    private LinearLayout pageShell;
    private FrameLayout contentStage;
    private LinearLayout composerDock;
    // Home task cards are rendered into this host by the task-card UI; it stays directly above the composer.
    private FrameLayout taskCardHost;
    private HomeTaskCards homeTaskCards;
    private HomeInputOverlay homeInputOverlay;
    private View composerPlaceholder;
    private TextView attachmentButton, composerClose;
    private LinearLayout homeComposerRow, homeComposerActions;
    private String nativePickerKind, nativePickerConversation, nativeCapturePath;
    private String voiceConversation;
    private boolean nativeAttachmentBusy;
    private boolean closingHomeInput;
    private boolean drawerClosing;
    private TextView state;
    private TextView clock;
    private TextView date;
    private EditText search;
    private final ExecutorService queryExecutor = Executors.newSingleThreadExecutor();
    private List<AgentLoop.Message> history = Collections.emptyList();
    private ChatStore chatStore;
    private String activePiRequestId;
    private ChatCoordinator chatCoordinator;
    private ChatCoordinator.Listener coordinatorListener;
    private String activePiMessageId;
    private TextView chatModelTitle;
    private LinearLayout messageList;
    private TextView piStreamingBody;
    private io.noties.markwon.Markwon markdown;
    private int piStreamingVisibleIndex;
    private ScrollView messageScroll;
    private EditText composerInput;
    private TextView sendButton;
    private TextView stopButton;
    private FrameLayout chatDrawer;
    private ConversationTreeSheet treeSheet;
    private TextView voiceButton;
    private TextView thinkingLevelButton;
    private TextView newerMessages;
    private final Object thinkingLevelQueryLock = new Object();
    private volatile PiAgentBridge thinkingLevelBridge;
    private volatile String thinkingLevelRequestId;
    private String thinkingLevelQueryToken;
    private final Set<String> expandedTools = new HashSet<>();
    private boolean agentRunning;
    private boolean forceScrollToBottom;
    private boolean pendingScrollToBottom;
    private boolean restoreChatScroll;
    private int savedChatScroll;
    private long renderGeneration;
    private long activityEpoch;
    private String page = "home";
    private String savedQuery = "";
    private String savedDraft = "";
    private final BroadcastReceiver packageChanges = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            String packageName = intent.getData() == null ? null
                    : intent.getData().getSchemeSpecificPart();
            if (packageName == null) return;
            boolean removed = Intent.ACTION_PACKAGE_REMOVED.equals(intent.getAction())
                    && !intent.getBooleanExtra(Intent.EXTRA_REPLACING, false);
            if (removed && homeDesktop != null) homeDesktop.packageRemoved(packageName);
            loadApps();
            if (homeDesktop != null) homeDesktop.appsChanged(apps);
        }
    };

    @Override protected void attachBaseContext(android.content.Context base) { super.attachBaseContext(UiText.wrap(base)); }
    private String t(String literal) { return UiText.get(this, literal); }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        appearance = AppAppearance.read(this);
        desktopAppearance = AppAppearance.readDesktop(this);
        desktopRevision = new DesktopPreferences(this).revision();
        IVORY = appearance.background; CHARCOAL = appearance.ink; TEAL = appearance.accent; MUTED = appearance.muted;
        appearanceRevision = AppAppearance.revision(this);
        initialWebRoute = "/chat/" + ChatCoordinator.get(this).store().activeId();
        if (savedInstanceState != null && "search".equals(savedInstanceState.getString(PAGE_KEY))) {
            initialWebRoute = savedInstanceState.getString("web_route", initialWebRoute);
        }
        registerPlugin(ChatPlugin.class);
        registerPlugin(BotPlugin.class);
        registerPlugin(ScheduledTasksPlugin.class);
        registerPlugin(SettingsPlugin.class);
        registerPlugin(DevicePlugin.class);
        super.onCreate(savedInstanceState);
        appearance.apply(this);
        // Registers read-aloud for finished replies even before the first dictation.
        VoiceManager.get(this);
        suppressHomeEnterTransition(getIntent());
        activityEpoch = ACTIVITY_EPOCH.acquire();
        shizukuRepair = new ShizukuRepair(this, () -> { });
        shizukuRepair.register();
        chatCoordinator = ChatCoordinator.get(this);
        chatStore = chatCoordinator.store();
        agentRunning = chatCoordinator.running(chatStore.activeId());
        coordinatorListener = (messages, event) -> {
            String activeConversation = chatStore.activeId();
            agentRunning = chatCoordinator.running(activeConversation);
            activePiRequestId = chatCoordinator.requestId();
            if (activeConversation.equals(event.optString("conversationId"))) {
                if ("textDelta".equals(event.optString("type"))) {
                    activePiMessageId = event.optString("nodeId", activePiMessageId);
                }
                showSnapshot(immutable(messages));
                if (state != null) state.setText(event.optJSONObject("payload") == null ? ""
                        : event.optJSONObject("payload").optString("message"));
            }
            updateAgentControls();
            String type = event.optString("type");
            // A spoken conversation starts a new chat on its own; follow it here too.
            if ("conversationSwitched".equals(type)) changeConversation();
            if ("runStatus".equals(type) || "snapshot".equals(type) || "extensionUi".equals(type)
                    || "end".equals(type) || "error".equals(type)
                    || "questionnairePending".equals(type) || "questionnaireReply".equals(type)
                    || "conversationArchived".equals(type) || "conversationRestored".equals(type)
                    || "conversationDeleted".equals(type)) refreshTaskCards();
        };
        chatCoordinator.addListener(coordinatorListener);
        markdown = ResponseMarkdown.create(this, uri -> launch(new Intent(Intent.ACTION_VIEW, uri)));
        history = immutable(chatStore.load());
        savedDraft = chatStore.draft();
        loadApps();
        launcherShortcuts = new LauncherShortcuts(this);
        homeLayout = HomeLayout.load(this, apps);
        removeActuallyUninstalledApps();
        registerPackageChanges();
        getWindow().setStatusBarColor(IVORY);
        getWindow().setNavigationBarColor(IVORY);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        getWindow().getDecorView().setSystemUiVisibility(appearance.systemBarFlags());
        if (savedInstanceState != null) {
            page = savedInstanceState.getString(PAGE_KEY, "home");
            savedQuery = savedInstanceState.getString(QUERY_KEY, "");
            savedDraft = savedInstanceState.getString(DRAFT_KEY, "");
            savedChatScroll = savedInstanceState.getInt(CHAT_SCROLL_KEY, 0);
            restoreChatScroll = "search".equals(page);
            ArrayList<String> expanded = savedInstanceState.getStringArrayList(EXPANDED_TOOLS_KEY);
            if (expanded != null) expandedTools.addAll(expanded);
        }
        boolean restoreWebPage = "search".equals(page);
        installPager();
        getOnBackPressedDispatcher().addCallback(this, new androidx.activity.OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                if (nativeSearchPage != null) { showDesktop(); return; }
                if (homeDesktop != null && homeDesktop.dismissMenu()) return;
                if (pager.page() == PagerState.Page.HOME) {
                    if (homeInputOverlay != null) {
                        androidx.core.view.WindowInsetsCompat insets = androidx.core.view.ViewCompat.getRootWindowInsets(root);
                        if (insets != null && insets.isVisible(androidx.core.view.WindowInsetsCompat.Type.ime()))
                            getSystemService(InputMethodManager.class).hideSoftInputFromWindow(composerInput.getWindowToken(), 0);
                        else closeHomeInput(true);
                    }
                    return;
                }
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
        });
        showHome(false);
        boolean pinIntent = isPinIntent(getIntent());
        handlePinIntent(getIntent());
        handleDesktopAction(getIntent());
        if (restoreWebPage && !pinIntent) pager.show(PagerState.Page.CHAT, false);
        if (savedInstanceState != null) {
            nativePickerKind = savedInstanceState.getString("native_picker_kind");
            nativePickerConversation = savedInstanceState.getString("native_picker_conversation");
            nativeCapturePath = savedInstanceState.getString("native_capture_path");
            voiceConversation = savedInstanceState.getString("voice_conversation");
            nativeAttachmentBusy = nativePickerKind != null;
            if (savedInstanceState.getBoolean("native_home_input")) {
                openHomeInput(false);
                homeInputOverlay.restore(savedInstanceState);
            }
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // BridgeActivity.load delivers the initial intent before installPager().
        if (pager != null && (isHomeIntent(intent) || isPinIntent(intent))) {
            suppressHomeEnterTransition(intent);
            showHome(false);
            handlePinIntent(intent);
        }
        if (pager != null) handleDesktopAction(intent);
    }

    @Override
    public void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        outState.putString(PAGE_KEY, page);
        outState.putBoolean("native_home_input", homeInputOverlay != null);
        if (homeInputOverlay != null) homeInputOverlay.save(outState);
        outState.putString("native_picker_kind", nativePickerKind);
        outState.putString("native_picker_conversation", nativePickerConversation);
        outState.putString("native_capture_path", nativeCapturePath);
        outState.putString("voice_conversation", voiceConversation);
        String webUrl = chatWebView.getUrl();
        outState.putString("web_route", webUrl != null && webUrl.contains("#/")
                ? webUrl.substring(webUrl.indexOf('#') + 1) : initialWebRoute);
        outState.putString(QUERY_KEY, search == null ? savedQuery : search.getText().toString());
        outState.putString(DRAFT_KEY, composerInput == null
                ? savedDraft : composerInput.getText().toString());
        outState.putInt(CHAT_SCROLL_KEY, messageScroll == null
                ? savedChatScroll : messageScroll.getScrollY());
        outState.putStringArrayList(EXPANDED_TOOLS_KEY, new ArrayList<>(expandedTools));
    }

    @Override
    public void onStart() {
        super.onStart();
        if (homeDesktop != null) homeDesktop.startListening();
        if (!desktopSettingsRegistered) {
            androidx.core.content.ContextCompat.registerReceiver(this, desktopSettingsChanged,
                    new android.content.IntentFilter(DesktopPreferences.ACTION_CHANGED), androidx.core.content.ContextCompat.RECEIVER_NOT_EXPORTED);
            desktopSettingsRegistered = true;
        }
        if (!shortcutListenerRegistered && launcherShortcuts.hasAccess()) try {
            launcherShortcuts.register(() -> runOnUiThread(() -> {
                if (homeDesktop != null) homeDesktop.shortcutsChanged();
            }));
            shortcutListenerRegistered = true;
        } catch (RuntimeException failure) {
            failure(t("无法监听快捷功能变化：") + failure.getMessage());
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        resumedActivity = new java.lang.ref.WeakReference<>(this);
        // Microphone services can only start while the app is visible; the launcher resumes often.
        WakeWordService.sync(this);
        if (desktopRevision != new DesktopPreferences(this).revision()) { recreate(); return; }
        agentRunning = chatCoordinator.running(chatStore.activeId());
        activePiRequestId = chatCoordinator.requestId();
        if (!agentRunning && !appearanceRevision.equals(AppAppearance.revision(this))) { recreate(); return; }
        GestureService.recover(this);
        shizukuRepair.resume();
        clockHandler.removeCallbacks(clockTick);
        clockTick.run();
        refreshTaskCards();
        if (homeTaskCards != null && pager.page() == PagerState.Page.HOME) homeTaskCards.showLatest();
        consumeOpenChatExtra();
        consumeArchiveUndoExtra();
        final long owner = activityEpoch;
        queryExecutor.execute(() -> {
            try { chatCoordinator.purgeExpiredArchives(); }
            catch (RuntimeException ignored) { }
            if (!ACTIVITY_EPOCH.owns(owner)) return;
            runOnUiThread(() -> {
                if (!ACTIVITY_EPOCH.owns(owner) || isFinishing()) return;
                refreshTaskCards();
            });
        });
        refreshHomeComposer();
        if (nativeSearchPage != null) nativeSearchPage.refresh();
        if (homeDesktop != null) {
            homeDesktop.shortcutsChanged();
            homeDesktop.syncPins();
        }
    }

    @Override
    public void onPause() {
        if (resumedActivity.get() == this) resumedActivity = new java.lang.ref.WeakReference<>(null);
        if (homeInputOverlay != null) homeInputOverlay.clearInput();
        savePiPreview();
        shizukuRepair.pause();
        clockHandler.removeCallbacks(clockTick);
        super.onPause();
    }

    @Override
    public void onStop() {
        if (homeDesktop != null) homeDesktop.stopListening();
        if (desktopSettingsRegistered) { unregisterReceiver(desktopSettingsChanged); desktopSettingsRegistered = false; }
        if (shortcutListenerRegistered) {
            launcherShortcuts.unregister();
            shortcutListenerRegistered = false;
        }
        super.onStop();
    }

    @Override
    public void onDestroy() {
        savePiPreview();
        if (treeSheet != null) treeSheet.dismiss();
        ACTIVITY_EPOCH.retire(activityEpoch);
        synchronized (thinkingLevelQueryLock) {
            PiAgentBridge queryBridge = thinkingLevelBridge;
            if (queryBridge != null) queryBridge.abort(thinkingLevelRequestId);
        }
        closeNativeSearch();
        VoiceManager.get(this).cancelListening();
        if (homeInputOverlay != null) homeInputOverlay.dispose();
        if (homeDesktop != null) homeDesktop.dispose();
        if (packageReceiverRegistered) {
            unregisterReceiver(packageChanges);
            packageReceiverRegistered = false;
        }
        queryExecutor.shutdownNow();
        chatCoordinator.removeListener(coordinatorListener);
        shizukuRepair.destroy();
        super.onDestroy();
    }

    @Override public void onConfigurationChanged(android.content.res.Configuration configuration) {
        super.onConfigurationChanged(configuration);
        if (chatWebView != null) chatWebView.getSettings().setTextZoom(
                Math.round(configuration.fontScale * 100));
    }

    private void installPager() {
        chatWebView = bridge.getWebView();
        android.view.ViewParent parent = chatWebView.getParent();
        if (parent instanceof android.view.ViewGroup) ((android.view.ViewGroup) parent).removeView(chatWebView);
        chatWebView.getSettings().setTextZoom(Math.round(
                getResources().getConfiguration().fontScale * 100));
        trustedWebContent = trustedWebUrl(chatWebView.getUrl());
        bridge.addWebViewListener(new com.getcapacitor.WebViewListener() {
            @Override public void onPageStarted(android.webkit.WebView view) {
                trustedWebContent = trustedWebUrl(view.getUrl());
            }
            @Override public void onPageCommitVisible(android.webkit.WebView view, String url) {
                trustedWebContent = trustedWebUrl(url);
            }
        });
        pager = new PagerRoot(this, chatWebView, PagerState.Page.HOME, changed -> {
            if (changed != PagerState.Page.HOME) leaveDesktopEdit();
            if (changed == PagerState.Page.HOME && "search".equals(page)) {
                // Settings/history are temporary routes, never the desktop's adjacent page.
                initialWebRoute = "/chat/" + chatStore.activeId();
                chatWebView.evaluateJavascript("if (!/^#\\/chat(?:\\/|$)/.test(location.hash)) location.replace("
                        + JSONObject.quote("#" + initialWebRoute) + ")", null);
            }
            page = changed == PagerState.Page.CHAT ? "search" : "home";
            if (changed == PagerState.Page.HOME && composerInput != null) refreshHomeComposer();
            if (taskCardHost != null) {
                taskCardHost.setVisibility(changed == PagerState.Page.HOME ? View.VISIBLE : View.GONE);
                if (changed == PagerState.Page.HOME) { refreshTaskCards(); homeTaskCards.showLatest(); }
            }
            if (changed == PagerState.Page.HOME) desktopAppearance.applySystemBars(this, Color.TRANSPARENT);
            else appearance.applySystemBars(this, appearance.surface);
        });
        chatWebView.addJavascriptInterface(new Object() {
            @android.webkit.JavascriptInterface public int gestureId() {
                return trustedWebContent ? pager.gestureId() : -1;
            }
            @android.webkit.JavascriptInterface public void setBlocked(int gestureId, boolean blocked) {
                if (trustedWebContent) pager.setGestureBlocked(gestureId, blocked);
            }
        }, "PagerGesture");
        setContentView(pager);
    }

    private boolean trustedWebUrl(String value) {
        if (value == null || bridge == null) return false;
        android.net.Uri expected = android.net.Uri.parse(bridge.getLocalUrl());
        android.net.Uri actual = android.net.Uri.parse(value);
        return expected.getScheme() != null && expected.getScheme().equals(actual.getScheme())
                && expected.getAuthority() != null
                && expected.getAuthority().equals(actual.getAuthority());
    }

    String launchRoute() { return initialWebRoute == null ? "/chat" : initialWebRoute; }

    void showHomeFromWeb() { runOnUiThread(() -> showHome(true)); }

    private static boolean isHomeIntent(Intent intent) {
        return intent != null && Intent.ACTION_MAIN.equals(intent.getAction())
                && intent.hasCategory(Intent.CATEGORY_HOME);
    }

    private void suppressHomeEnterTransition(Intent intent) {
        if (!isHomeIntent(intent)) return;
        if (Build.VERSION.SDK_INT >= 34) {
            overrideActivityTransition(Activity.OVERRIDE_TRANSITION_OPEN, 0, 0);
        } else {
            overridePendingTransition(0, 0);
        }
    }

    private void loadApps() {
        apps.clear();
        apps.addAll(DeviceActions.apps(this));
    }

    @SuppressWarnings("deprecation")
    private void registerPackageChanges() {
        IntentFilter filter = new IntentFilter();
        filter.addAction(Intent.ACTION_PACKAGE_ADDED);
        filter.addAction(Intent.ACTION_PACKAGE_CHANGED);
        filter.addAction(Intent.ACTION_PACKAGE_REMOVED);
        filter.addDataScheme("package");
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(packageChanges, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(packageChanges, filter);
        }
        packageReceiverRegistered = true;
    }

    private void removeActuallyUninstalledApps() {
        boolean changed = false;
        for (String packageName : homeLayout.packageNames()) {
            try {
                ApplicationInfo app = Build.VERSION.SDK_INT >= 33
                        ? getPackageManager().getApplicationInfo(packageName,
                                PackageManager.ApplicationInfoFlags.of(
                                        PackageManager.MATCH_UNINSTALLED_PACKAGES))
                        : installedApplicationLegacy(packageName);
                if ((app.flags & ApplicationInfo.FLAG_INSTALLED) == 0) {
                    changed |= homeLayout.removePackage(packageName);
                }
            } catch (PackageManager.NameNotFoundException missing) {
                changed |= homeLayout.removePackage(packageName);
            }
        }
        if (changed) homeLayout.save();
    }

    @SuppressWarnings("deprecation")
    private ApplicationInfo installedApplicationLegacy(String packageName)
            throws PackageManager.NameNotFoundException {
        return getPackageManager().getApplicationInfo(
                packageName, PackageManager.MATCH_UNINSTALLED_PACKAGES);
    }

    private static boolean isPinIntent(Intent intent) {
        return intent != null && LauncherApps.ACTION_CONFIRM_PIN_SHORTCUT.equals(intent.getAction());
    }

    private void handlePinIntent(Intent intent) {
        if (!isPinIntent(intent) || homeDesktop == null) return;
        LauncherApps launcherApps = getSystemService(LauncherApps.class);
        LauncherApps.PinItemRequest request;
        try {
            request = launcherApps == null ? null : launcherApps.getPinItemRequest(intent);
        } catch (RuntimeException failure) {
            request = null;
        }
        // A PinItemRequest can be accepted only once. Consuming the action prevents recreation from reopening it.
        intent.setAction(null);
        if (request == null) {
            failure(t("固定请求已失效。"));
            return;
        }
        homeDesktop.confirmPin(request);
    }

    private void setPage(View content) {
        boolean firstPage = root == null;
        if (firstPage) createPageShell();
        for (int index = 0; index < contentStage.getChildCount(); index++) {
            contentStage.getChildAt(index).animate().cancel();
        }
        contentStage.removeAllViews();
        contentStage.addView(content, match());
        boolean chat = "search".equals(page);
        composerDock.setVisibility(View.GONE);
        root.setBackgroundColor(chat ? appearance.surface : desktopBackground());
        homeWallpaper.setVisibility(chat ? View.INVISIBLE : View.VISIBLE);
        if (chat) appearance.applySystemBars(this, appearance.surface);
        else desktopAppearance.applySystemBars(this, Color.TRANSPARENT);
        composerInput.setShowSoftInputOnFocus(false);
        if (!firstPage) enterMotion(content, chat ? 24 : -16);
        updateAgentControls();
    }

    private void createPageShell() {
        root = new FrameLayout(this);
        root.setClipToPadding(false);
        root.setBackgroundColor(appearance.surface);
        homeWallpaper = desktopAppearance.desktopWallpaper(this);
        if ("system".equals(new DesktopPreferences(this).wallpaper())) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WALLPAPER);
            getWindow().setBackgroundDrawableResource(android.R.color.transparent);
        } else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WALLPAPER);
        root.setBackgroundColor(desktopBackground());
        root.addView(homeWallpaper, match());
        pageShell = new LinearLayout(this);
        pageShell.setOrientation(LinearLayout.VERTICAL);
        pageShell.setFocusableInTouchMode(true);
        contentStage = new FrameLayout(this);
        pageShell.addView(contentStage, new LinearLayout.LayoutParams(-1, 0, 1));
        taskCardHost = new FrameLayout(this);
        taskCardHost.setVisibility(View.GONE);
        homeTaskCards = new HomeTaskCards(this, pager, homeWallpaper, this::openConversation,
                id -> chatCoordinator.cancel(id), this::archiveConversation, this::showArchivedList);
        homeTaskCards.setQuestionReply((conversationId, requestId, questionnaireId, answers, cancelled) -> {
            if (cancelled) chatCoordinator.cancelQuestionnaire(conversationId, requestId, questionnaireId);
            else chatCoordinator.submitQuestionnaire(conversationId, requestId, questionnaireId, answers, null);
        });
        refreshTaskCards();
        createComposer();
        pageShell.addView(composerDock, new LinearLayout.LayoutParams(-1, -2));
        root.addView(pageShell, match());
        pageShell.requestFocus();
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            int left;
            int top;
            int right;
            int bottom;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets occupied = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout()
                                | WindowInsets.Type.ime());
                left = occupied.left;
                top = occupied.top;
                right = occupied.right;
                bottom = occupied.bottom;
            } else {
                left = insets.getSystemWindowInsetLeft();
                top = insets.getSystemWindowInsetTop();
                right = insets.getSystemWindowInsetRight();
                bottom = insets.getSystemWindowInsetBottom();
            }
            if (view.getPaddingLeft() == left && view.getPaddingTop() == top
                    && view.getPaddingRight() == right && view.getPaddingBottom() == bottom) {
                return insets;
            }
            ScrollView chatScroll = messageScroll;
            boolean preserveChat = chatScroll != null && messageList != null
                    && "search".equals(page) && !restoreChatScroll;
            boolean follow = preserveChat && (pendingScrollToBottom || nearLatest());
            ScrollAnchor anchor = preserveChat && !follow ? visibleAnchor() : null;
            if (follow) pendingScrollToBottom = true;
            view.setPadding(left, top, right, bottom);
            FrameLayout.LayoutParams wallpaperParams = (FrameLayout.LayoutParams) homeWallpaper.getLayoutParams();
            wallpaperParams.setMargins(-left, -top, -right, -bottom);
            homeWallpaper.setLayoutParams(wallpaperParams);
            if (preserveChat) {
                long generation = ++renderGeneration;
                chatScroll.post(() -> {
                    if (messageScroll != chatScroll || generation != renderGeneration) return;
                    if (follow) scrollToLatest(); else restoreAnchor(anchor);
                });
            }
            return insets;
        });
        pager.setHome(root);
    }

    private void showHome() {
        showHome(true);
    }

    private void showHome(boolean animated) {
        closeNativeSearch(animated);
        if (homeInputOverlay != null) closeHomeInput(false);
        if (treeSheet != null) treeSheet.dismiss();
        View focused = getCurrentFocus();
        if (focused != null) {
            android.view.inputmethod.InputMethodManager keyboard =
                    getSystemService(android.view.inputmethod.InputMethodManager.class);
            if (keyboard != null) keyboard.hideSoftInputFromWindow(focused.getWindowToken(), 0);
        }
        closeChatDrawer(false);
        if (root != null) {
            refreshHomeComposer();
            pager.show(PagerState.Page.HOME, animated);
            return;
        }
        page = "home";
        savedQuery = search == null ? savedQuery : search.getText().toString();
        savedDraft = composerInput == null ? savedDraft : composerInput.getText().toString();
        savedChatScroll = messageScroll == null ? savedChatScroll : messageScroll.getScrollY();
        messageScroll = null;
        messageList = null;
        newerMessages = null;
        search = null;
        state = null;

        FrameLayout homeContent = new FrameLayout(this);
        homeContent.setPadding(dp(12), dp(8), dp(12), dp(8));
        homeDesktop = new HomeDesktop(this, pager, homeLayout, apps, launcherShortcuts, homeContent);
        homeContent.addView(homeDesktop, new FrameLayout.LayoutParams(-1, -1));
        homeDesktop.setNavigation(this::showAppLibrary, () -> showGlobalSearch(""),
                () -> launchWeb("/chat/" + chatStore.activeId(), null, null), this::openDesktopSettings,
                new HomeDesktop.Overlay() {
                    @Override public void pull(boolean search, float progress) {
                        pullNativeSearch(search, progress);
                    }
                    @Override public void settle(boolean search, boolean open, float velocity) {
                        settleNativeSearch(search, open, velocity);
                    }
                });

        setPage(homeContent);
        homeDesktop.setAiWidget(homeTaskCards);
        pager.show(PagerState.Page.HOME, animated);
        updateClock();
    }

    private int desktopBackground() {
        return "system".equals(new DesktopPreferences(this).wallpaper()) ? android.graphics.Color.TRANSPARENT : desktopAppearance.background;
    }
    private void handleDesktopAction(Intent intent) {
        String action = intent == null ? null : intent.getStringExtra("desktop_settings_action");
        if (action == null || homeDesktop == null) return;
        if (desktopRevision != new DesktopPreferences(this).revision()) { recreate(); return; }
        intent.removeExtra("desktop_settings_action");
        if ("assistant_settings".equals(action)) { openAssistantSettings(); return; }
        showDesktop();
        homeDesktop.post(() -> {
            if ("add_widget".equals(action)) homeDesktop.showAddMenu();
            else if ("edit_dock".equals(action)) homeDesktop.editDock();
            else if ("manage_folders".equals(action)) homeDesktop.manageFolders();
            else if ("edit_widgets".equals(action)) homeDesktop.enterEdit();
        });
    }

    public void showDesktop() { showHome(); }
    public void showAppLibrary() { showNativeSearch(NativeSearchPage.Mode.APP_LIBRARY, ""); }
    public void showGlobalSearch(String initialQuery) { showNativeSearch(NativeSearchPage.Mode.GLOBAL_SEARCH, initialQuery); }
    private void closeNativeSearch() { closeNativeSearch(true); }
    private void closeNativeSearch(boolean animated) {
        if (nativeSearchPage == null) return;
        if (!animated || !Motion.enabled()) {
            finishNativeSearch();
            return;
        }
        settleNativeSearch(searchMode == NativeSearchPage.Mode.GLOBAL_SEARCH, false, 0);
    }
    private void showNativeSearch(NativeSearchPage.Mode mode, String query) {
        prepareDesktopForSearch();
        attachNativeSearch(mode, query);
        settleNativeSearch(mode == NativeSearchPage.Mode.GLOBAL_SEARCH, true, 0);
    }
    private void prepareDesktopForSearch() {
        if (root == null || homeDesktop == null) showHome(false);
        else {
            if (homeInputOverlay != null) closeHomeInput(false);
            if (treeSheet != null) treeSheet.dismiss();
            pager.show(PagerState.Page.HOME, false);
        }
    }
    private NativeSearchPage.Host searchHost() {
        return new NativeSearchPage.Host() {
            public void showDesktop() { closeNativeSearch(true); }
            public void sendToAssistant(String prompt) { sendSearchToAssistant(prompt); }
            public void openSettings(String destination) {
                if ("assistant".equals(destination)) openAssistantSettings();
                else startActivity(new Intent(MainActivity.this, DesktopSettingsActivity.class)
                        .putExtra("desktop_destination", destination));
            }
            public void onDragStarted(NativeSearchPage.DragItem payload) {
                HomeLayout.Item item = payload.shortcutId() == null
                        ? HomeLayout.Item.app(payload.component().getPackageName(), payload.component().getClassName())
                        : HomeLayout.Item.shortcut(payload.component().getPackageName(), payload.shortcutId(), payload.userSerial());
                homeDesktop.acceptExternalDrag(payload, item);
                closeNativeSearch(false);
            }
        };
    }
    private void attachNativeSearch(NativeSearchPage.Mode mode, String query) {
        if (nativeSearchPage != null && searchMode == mode && !searchClosing) return;
        finishNativeSearch();
        searchMode = mode;
        searchClosing = false;
        nativeSearchPage = new NativeSearchPage(this, mode, query, searchHost());
        nativeSearchPage.setTranslationY(searchOffscreen(mode));
        root.addView(nativeSearchPage, match());
        nativeSearchPage.bringToFront();
    }
    private float searchOffscreen(NativeSearchPage.Mode mode) {
        float height = Math.max(1, root == null ? 1 : root.getHeight());
        return mode == NativeSearchPage.Mode.APP_LIBRARY ? height : -height;
    }
    private void applySearchProgress(float progress) {
        if (nativeSearchPage == null) return;
        float clamped = Math.max(0, Math.min(1, progress));
        nativeSearchPage.setTranslationY((1 - clamped) * (searchMode == NativeSearchPage.Mode.APP_LIBRARY
                ? Math.max(1, root.getHeight()) : -Math.max(1, root.getHeight())));
    }
    private void pullNativeSearch(boolean search, float progress) {
        prepareDesktopForSearch();
        NativeSearchPage.Mode mode = search ? NativeSearchPage.Mode.GLOBAL_SEARCH : NativeSearchPage.Mode.APP_LIBRARY;
        if (nativeSearchPage == null || searchMode != mode || searchClosing) attachNativeSearch(mode, "");
        if (searchSpring != null) { searchSpring.cancel(); searchSpring = null; }
        searchClosing = false;
        pageShell.setVisibility(View.VISIBLE);
        applySearchProgress(progress);
    }
    private void settleNativeSearch(boolean search, boolean open, float velocity) {
        if (open) leaveDesktopEdit();
        NativeSearchPage.Mode mode = search ? NativeSearchPage.Mode.GLOBAL_SEARCH : NativeSearchPage.Mode.APP_LIBRARY;
        if (nativeSearchPage == null) {
            if (open) showNativeSearch(mode, "");
            return;
        }
        if (searchSpring != null) { searchSpring.cancel(); searchSpring = null; }
        float end = open ? 0 : searchOffscreen(searchMode);
        searchClosing = !open;
        pageShell.setVisibility(View.VISIBLE);
        if (!open && homeDesktop != null) homeDesktop.ignoreEdit(600);
        NativeSearchPage page = nativeSearchPage;
        if (!Motion.enabled()) {
            page.setTranslationY(end);
            if (open) hideDesktopForSearch();
            else finishNativeSearch();
            return;
        }
        searchSpring = Motion.spring(page, androidx.dynamicanimation.animation.DynamicAnimation.TRANSLATION_Y,
                end, velocity, (a, canceled, value, vel) -> {
                    if (canceled) return;
                    searchSpring = null;
                    if (open) hideDesktopForSearch();
                    else if (nativeSearchPage == page) finishNativeSearch();
                });
    }
    private void hideDesktopForSearch() {
        if (nativeSearchPage != null) nativeSearchPage.setTranslationY(0);
        pageShell.setVisibility(View.INVISIBLE);
        searchClosing = false;
    }
    private void finishNativeSearch() {
        if (searchSpring != null) { searchSpring.cancel(); searchSpring = null; }
        NativeSearchPage old = nativeSearchPage;
        nativeSearchPage = null;
        searchClosing = false;
        if (old != null) {
            old.dispose();
            if (old.getParent() == root) root.removeView(old);
        }
        if (pageShell != null) pageShell.setVisibility(View.VISIBLE);
        if (homeDesktop != null) homeDesktop.ignoreEdit(600);
    }
    public void openChat(String conversationId) {
        openConversation(conversationId);
    }

    private void consumeOpenChatExtra() {
        String taskChat = getIntent().getStringExtra(TaskDetailActivity.EXTRA_OPEN_CHAT);
        if (taskChat == null) return;
        getIntent().removeExtra(TaskDetailActivity.EXTRA_OPEN_CHAT);
        openConversation(taskChat);
    }

    private void consumeArchiveUndoExtra() {
        String archived = getIntent().getStringExtra(TaskDetailActivity.EXTRA_ARCHIVED_ID);
        if (archived == null) return;
        getIntent().removeExtra(TaskDetailActivity.EXTRA_ARCHIVED_ID);
        showArchiveUndo(archived);
    }

    private void openConversation(String conversationId) {
        if (conversationId == null || conversationId.isEmpty()) {
            chatStore.newConversation();
            launchWeb("/chat/" + chatStore.activeId(), null, null);
            return;
        }
        try {
            if (chatStore.isArchived(conversationId)) {
                ConversationArchiveUi.promptArchived(this, archivedAt(conversationId),
                        () -> restoreThenOpen(conversationId),
                        () -> selectAndOpen(conversationId));
                return;
            }
            selectAndOpen(conversationId);
        } catch (RuntimeException exception) { failure(exception.getMessage()); }
    }

    private void restoreThenOpen(String conversationId) {
        try {
            chatCoordinator.restoreConversation(conversationId);
            refreshTaskCards();
            selectAndOpen(conversationId);
        } catch (RuntimeException exception) { failure(exception.getMessage()); }
    }

    private void selectAndOpen(String conversationId) {
        chatStore.selectConversation(conversationId);
        launchWeb("/chat/" + conversationId, null, null);
    }

    private long archivedAt(String conversationId) {
        for (ChatStore.Conversation conversation : chatStore.archivedConversations())
            if (conversation.id.equals(conversationId)) return conversation.archivedAt;
        return 0;
    }
    public void openTaskDetail(String conversationId) {
        leaveDesktopEdit();
        startActivity(new Intent(this, TaskDetailActivity.class)
                .putExtra(TaskDetailActivity.EXTRA_CONVERSATION_ID, conversationId));
    }
    public void openDesktopSettings() {
        leaveDesktopEdit();
        startActivity(new Intent(this, DesktopSettingsActivity.class));
    }
    public void openAssistantSettings() {
        launchWeb("/settings", null, null);
    }
    private void leaveDesktopEdit() {
        if (homeDesktop != null) homeDesktop.exitEdit();
    }
    void beginDesktopDrag(View source, HomeLayout.Item item) {
        homeDesktop.beginExternalDrag(source, item); showDesktop();
    }

    private void refreshTaskCards() {
        if (homeTaskCards == null) return;
        homeTaskCards.update(chatCoordinator.taskCards());
        taskCardHost.setVisibility("home".equals(page) && homeInputOverlay == null ? View.VISIBLE : View.GONE);
    }

    private void showSearch() {
        launchWeb("/chat/" + chatStore.activeId(), null, null);
    }

    /** Explicit local-search AI action: never reuse a draft or submit merely by typing. */
    public void sendSearchToAssistant(String query) {
        String prompt = query == null ? "" : query.trim();
        if (prompt.isEmpty()) return;
        String conversationId = java.util.UUID.randomUUID().toString();
        chatStore.selectConversation(conversationId);
        try {
            String accepted = chatCoordinator.send(conversationId, prompt, java.util.UUID.randomUUID().toString());
            if (accepted != null) launchWeb("/chat/" + conversationId, null, null);
        } catch (Exception exception) {
            failure(exception.getMessage());
        }
    }

    private void launchWeb(String route, String prompt, String submissionId) {
        if (route == null || !route.startsWith("/")) throw new IllegalArgumentException("route must be local");
        leaveDesktopEdit();
        if (homeInputOverlay != null) closeHomeInput(false);
        closeNativeSearch();
        initialWebRoute = route;
        page = "search";
        // The retained chat page also needs a refresh when the target hash is unchanged.
        chatWebView.evaluateJavascript("location.hash=" + JSONObject.quote("#" + route)
                + ";window.dispatchEvent(new Event('native-navigation'))", null);
        pager.show(PagerState.Page.CHAT, true);
        if (prompt != null && submissionId != null) try {
            chatCoordinator.send(prompt, submissionId);
        } catch (Exception ignored) {
            // Snapshot/event recovery exposes the actual rejection to the Web UI.
        }
    }

    private void showSearchNative() {
        page = "search";
        clock = null;
        date = null;
        search = null;

        LinearLayout pageColumn = column();
        LinearLayout header = row();
        header.setPadding(dp(8), dp(4), dp(8), dp(4));
        header.addView(chatIcon("menu", t("打开会话菜单"), view -> showChatDrawer()));
        TextView title = label(currentModelLabel(), 18, CHARCOAL);
        chatModelTitle = title;
        title.setSingleLine(true);
        title.setEllipsize(android.text.TextUtils.TruncateAt.END);
        title.setGravity(Gravity.CENTER);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        title.setContentDescription(t("选择模型与配置服务"));
        title.setOnClickListener(view -> {
            if (canChangeConversation()) startActivityForResult(new Intent(this, PiSettingsActivity.class).putExtra("pickModel", true), 702);
        });
        title.setFocusable(true);
        header.addView(title, new LinearLayout.LayoutParams(0, dp(52), 1));
        header.addView(chatIcon("compose", t("新建对话"), view -> newConversation()));
        pageColumn.addView(header);

        messageList = column();
        messageList.setPadding(dp(20), dp(22), dp(20), dp(16));
        messageScroll = new ScrollView(this);
        messageScroll.setClipToPadding(false);
        messageScroll.setFillViewport(true);
        messageScroll.setVerticalScrollBarEnabled(false);
        messageScroll.setOnTouchListener((view, event) -> {
            if (event.getActionMasked() == android.view.MotionEvent.ACTION_DOWN
                    || event.getActionMasked() == android.view.MotionEvent.ACTION_MOVE) {
                pendingScrollToBottom = false;
                renderGeneration++;
            }
            return false;
        });
        messageScroll.addView(messageList, new ScrollView.LayoutParams(-1, -2));
        pageColumn.addView(messageScroll, new LinearLayout.LayoutParams(-1, 0, 1));

        newerMessages = pill(t("↓ 有新消息"), view -> scrollToLatest());
        newerMessages.setVisibility(View.GONE);
        newerMessages.setContentDescription(t("滚动到最新消息"));
        pageColumn.addView(newerMessages, new LinearLayout.LayoutParams(-1, -2));

        state = label(agentRunning ? t("正在运行…") : "", 12, MUTED);
        state.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_ASSERTIVE);
        state.setPadding(dp(20), 0, dp(20), dp(4));
        pageColumn.addView(state);

        setPage(pageColumn);
        forceScrollToBottom = !restoreChatScroll;
        renderMessages();
        if (restoreChatScroll) {
            ScrollView current = messageScroll;
            current.post(() -> {
                if (messageScroll == current) current.scrollTo(0, savedChatScroll);
            });
            restoreChatScroll = false;
        }
        updateAgentControls();
    }

    private void openHomeInput(boolean showKeyboard) {
        if (homeInputOverlay != null) return;
        composerDock.setVisibility(View.VISIBLE);
        int[] start = new int[2]; composerDock.getLocationInWindow(start);
        int[] origin = new int[2]; root.getLocationInWindow(origin);
        composerPlaceholder = new View(this);
        int dockIndex = pageShell.indexOfChild(composerDock);
        int height = composerDock.getHeight();
        pageShell.removeView(composerDock);
        pageShell.addView(composerPlaceholder, dockIndex, new LinearLayout.LayoutParams(-1, height));
        HomeInputOverlay overlay = new HomeInputOverlay(this, pager, chatStore, apps,
                composerDock, composerInput, attachmentButton, voiceButton, sendButton,
                id -> { chatStore.selectConversation(id); launchWeb("/chat/" + id, null, null); }, this::sendMessage);
        homeInputOverlay = overlay;
        expandHomeComposer(true);
        overlay.setPreparing(nativeAttachmentBusy);
        composerClose.setVisibility(View.VISIBLE);
        composerInput.setMaxLines(4);
        pageShell.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        pageShell.setVisibility(View.INVISIBLE);
        taskCardHost.setVisibility(View.GONE);
        root.addView(overlay, match());
        composerDock.setTranslationY(Math.max(0, start[1] - origin[1] - root.getPaddingTop()));
        composerDock.animate().translationY(0).setDuration(motionDuration(240))
                .setInterpolator(new android.view.animation.DecelerateInterpolator()).start();
        composerInput.requestFocus();
        if (showKeyboard) composerInput.post(() -> {
            if (homeInputOverlay == overlay && !closingHomeInput)
                getSystemService(InputMethodManager.class).showSoftInput(composerInput, InputMethodManager.SHOW_IMPLICIT);
        });
    }

    private void closeHomeInput(boolean animated) {
        HomeInputOverlay overlay = homeInputOverlay;
        if (overlay == null) return;
        if (closingHomeInput && animated) return;
        closingHomeInput = true;
        overlay.clearInput();
        composerDock.animate().cancel();
        getSystemService(InputMethodManager.class).hideSoftInputFromWindow(composerInput.getWindowToken(), 0);
        composerInput.clearFocus();
        Runnable finish = () -> {
            if (homeInputOverlay != overlay) return;
            overlay.dispose(); overlay.removeView(composerDock);
            root.removeView(overlay);
            int index = pageShell.indexOfChild(composerPlaceholder);
            pageShell.removeView(composerPlaceholder);
            pageShell.addView(composerDock, index, new LinearLayout.LayoutParams(-1, -2));
            composerDock.setVisibility(View.GONE);
            composerDock.setTranslationY(0);
            homeInputOverlay = null; closingHomeInput = false;
            composerClose.setVisibility(View.GONE);
            expandHomeComposer(false);
            composerInput.setKeyListener(null); composerInput.setCursorVisible(false);
            composerInput.setFocusable(false);
            composerInput.setShowSoftInputOnFocus(false); composerInput.setMaxLines(1);
            composerInput.setContentDescription(t("打开新建对话输入"));
            attachmentButton.setVisibility(View.VISIBLE); attachmentButton.setEnabled(true);
            voiceButton.setVisibility(View.VISIBLE); sendButton.setVisibility(View.VISIBLE);
            pageShell.setVisibility(View.VISIBLE);
            pageShell.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);
            pageShell.requestFocus(); refreshHomeComposer(); refreshTaskCards();
        };
        if (!animated) { finish.run(); return; }
        int[] target = new int[2]; composerPlaceholder.getLocationInWindow(target);
        int[] current = new int[2]; composerDock.getLocationInWindow(current);
        composerDock.animate().translationY(target[1] - current[1]).setDuration(motionDuration(220))
                .setInterpolator(new android.view.animation.DecelerateInterpolator()).withEndAction(finish).start();
    }

    private void chooseHomeAttachment(String kind) {
        if (homeInputOverlay == null || nativeAttachmentBusy) return;
        java.io.File capture = null;
        try {
            nativePickerConversation = homeInputOverlay.draftId();
            capture = "camera".equals(kind) ? AttachmentPicker.cameraFile(this) : null;
            Intent intent = AttachmentPicker.intent(this, kind, capture);
            nativePickerKind = kind; nativeCapturePath = capture == null ? null : capture.getAbsolutePath();
            nativeAttachmentBusy = true; homeInputOverlay.setPreparing(true);
            startActivityForResult(intent, 42);
        } catch (Exception exception) {
            if (capture != null) capture.delete();
            nativePickerKind = null; nativeCapturePath = null; nativePickerConversation = null;
            nativeAttachmentBusy = false; homeInputOverlay.setPreparing(false);
            failure(exception.getMessage());
        }
    }

    private void finishHomeAttachment(int result, Intent data) {
        final String conversation = nativePickerConversation, kind = nativePickerKind, path = nativeCapturePath;
        nativePickerConversation = null; nativePickerKind = null; nativeCapturePath = null;
        if (result != RESULT_OK || conversation == null) {
            if (path != null) new java.io.File(path).delete();
            nativeAttachmentBusy = false;
            if (homeInputOverlay != null) homeInputOverlay.setPreparing(false);
            return;
        }
        final long owner = activityEpoch;
        queryExecutor.execute(() -> {
            String error = null;
            try {
                AttachmentPicker.importResult(getApplicationContext(), chatStore, conversation, kind,
                        path == null ? null : new java.io.File(path), data);
            } catch (Exception exception) { error = exception.getMessage(); }
            final String message = error;
            runOnUiThread(() -> {
                if (!ACTIVITY_EPOCH.owns(owner)) return;
                nativeAttachmentBusy = false;
                if (homeInputOverlay != null) { homeInputOverlay.setPreparing(false); homeInputOverlay.refreshAttachments(); }
                else refreshHomeComposer();
                if (message != null) failure(message);
            });
        });
    }

    private void createComposer() {
        composerDock = column();
        composerDock.setBackgroundColor(Color.TRANSPARENT);
        LinearLayout composer = column();
        composer.setPadding(dp(8), dp(6), dp(8), dp(6));
        composer.setBackgroundColor(Color.TRANSPARENT);
        composerInput = new EditText(this);
        composerInput.setHint(t("发消息…"));
        composerInput.setContentDescription(t("打开新建对话输入"));
        composerInput.setTextColor(CHARCOAL);
        composerInput.setHintTextColor(MUTED);
        composerInput.setTextSize(16);
        composerInput.setMaxLines(2);
        composerInput.setMinHeight(dp(44));
        composerInput.setBackgroundColor(Color.TRANSPARENT);
        composerInput.setPadding(dp(10), dp(6), dp(10), dp(4));
        composerInput.setText(savedDraft);
        composerInput.setCursorVisible(false);
        composerInput.setKeyListener(null);
        composerInput.setFocusable(false);
        composerInput.setShowSoftInputOnFocus(false);
        composerInput.setOnClickListener(view -> { if (homeInputOverlay == null) openHomeInput(true); });
        LinearLayout inputRow = row();
        homeComposerRow = inputRow;
        inputRow.setGravity(Gravity.CENTER_VERTICAL);
        inputRow.addView(composerInput, new LinearLayout.LayoutParams(0, -2, 1));
        composerClose = chatIcon("close", t("关闭输入"), view -> closeHomeInput(true));
        composerClose.setVisibility(View.GONE);
        inputRow.addView(composerClose);
        composer.addView(inputRow, new LinearLayout.LayoutParams(-1, -2));
        LinearLayout actions = row();
        homeComposerActions = actions;
        attachmentButton = chatIcon("plus", t("添加附件"), view -> {
            openHomeInput(false);
            homeInputOverlay.select(2);
            new android.app.AlertDialog.Builder(this).setItems(
                    new String[]{t("拍照"), t("上传图片"), t("上传附件")},
                    (dialog, which) -> chooseHomeAttachment(new String[]{"camera", "image", "file"}[which])).show();
        });
        actions.addView(attachmentButton);
        actions.addView(new View(this), new LinearLayout.LayoutParams(0, 1, 1));
        voiceButton = chatIcon("mic", t("语音输入"), view -> startDictation());
        actions.addView(voiceButton);
        sendButton = chatIcon("send", t("发送消息"), view -> sendMessage());
        sendButton.setBackground(shape(appearance.accent, 24, 0, 0));
        actions.addView(sendButton);
        composer.addView(actions, new LinearLayout.LayoutParams(-1, dp(48)));
        FrameLayout glass = appearance.glass(this, homeWallpaper, 28);
        glass.addView(composer, new FrameLayout.LayoutParams(-1, -2));
        LinearLayout.LayoutParams composerParams = new LinearLayout.LayoutParams(-1, -2);
        composerParams.setMargins(dp(12), dp(4), dp(12), dp(8));
        composerDock.addView(glass, composerParams);
        expandHomeComposer(false);
    }

    private void expandHomeComposer(boolean expanded) {
        ((android.view.ViewGroup) voiceButton.getParent()).removeView(voiceButton);
        ((android.view.ViewGroup) sendButton.getParent()).removeView(sendButton);
        LinearLayout target = expanded ? homeComposerActions : homeComposerRow;
        target.addView(voiceButton);
        target.addView(sendButton);
        homeComposerActions.setVisibility(expanded ? View.VISIBLE : View.GONE);
        composerInput.setMaxLines(expanded ? 4 : 1);
    }

    private void refreshHomeComposer() {
        if (composerInput == null) return;
        if (homeInputOverlay != null) { homeInputOverlay.refreshAttachments(); return; }
        String id = chatStore.homeDraftId();
        savedDraft = id == null ? "" : chatStore.draft(id);
        if (!savedDraft.contentEquals(composerInput.getText())) composerInput.setText(savedDraft);
        int attachments = id == null ? 0 : chatStore.draftAttachments(id).size();
        composerInput.setHint(attachments == 0 ? t("发消息…") : attachments + t(" 个附件"));
        updateAgentControls();
    }

    private void openConversationTree() {
        launchWeb("/history/" + chatStore.activeId(), null, null);
    }

    private void openConversationTreeNative() {
        if (treeSheet != null) return;
        if (!"search".equals(page)) showSearch();
        getSystemService(InputMethodManager.class).hideSoftInputFromWindow(composerInput.getWindowToken(), 0);
        treeSheet = new ConversationTreeSheet(this, chatStore.tree(), node -> {
            if (!canChangeConversation()) return;
            boolean edit = "user".equals(node.message.role);
            chatStore.selectNode(edit ? node.parentId : node.id);
            if (edit) chatStore.saveDraft(node.message.content == null ? "" : node.message.content);
            history = immutable(chatStore.load());
            savedDraft = chatStore.draft();
            treeSheet.dismiss();
            forceScrollToBottom = true;
            showSearch();
            composerInput.setText(savedDraft);
            if (edit) {
                composerInput.requestFocus();
                composerInput.setSelection(composerInput.length());
                composerInput.post(() -> getSystemService(InputMethodManager.class)
                        .showSoftInput(composerInput, InputMethodManager.SHOW_IMPLICIT));
            }
        });
        treeSheet.setOnDismissListener(dialog -> treeSheet = null);
        treeSheet.show();
    }

    private long motionDuration(long milliseconds) {
        return Motion.duration(milliseconds);
    }

    private void enterMotion(View view, int offsetDp) {
        Motion.enter(view, dp(offsetDp));
    }

    private void pressFeedback(View view) {
        Motion.press(view);
    }

    private void animateExpansion(LinearLayout parent) {
        Motion.expand(parent);
    }

    private TextView chatIcon(String icon, String description, View.OnClickListener listener) {
        TextView button = label("", 16, CHARCOAL);
        button.setLayoutParams(new LinearLayout.LayoutParams(dp(48), dp(48)));
        button.setBackground(new android.graphics.drawable.RippleDrawable(
                android.content.res.ColorStateList.valueOf(0x18000000), null,
                shape(appearance.surface, 24, 0, 0)));
        ChatIcon drawable = new ChatIcon(icon,
                "send".equals(icon) || "stop".equals(icon) ? (appearance.dark ? appearance.surface : Color.WHITE) : CHARCOAL);
        drawable.setBounds(0, 0, dp(24), dp(24));
        button.setCompoundDrawables(drawable, null, null, null);
        button.setPadding(dp(12), dp(12), dp(12), dp(12));
        button.setContentDescription(description);
        button.setFocusable(true);
        button.setOnClickListener(listener);
        pressFeedback(button);
        return button;
    }

    private void showThinkingLevelPicker() {
        launchWeb("/chat?panel=models", null, null);
    }

    private void showThinkingLevelPickerNative() {
        if (!canChangeConversation() || thinkingLevelQueryToken != null) return;
        if ("home".equals(page)) showSearch();
        final String conversationId = chatStore.activeId();
        final long owner = activityEpoch;
        final String provider;
        final String model;
        final String selectionSource = chatStore.piSelection();
        final String snapshot;
        final PiConfigStore queryStore = new PiConfigStore(this, conversationId);
        try {
            queryStore.initialize(getSharedPreferences("chat", MODE_PRIVATE));
            JSONObject selection = new JSONObject(selectionSource);
            java.util.Map<String, Object> settings = queryStore.effectiveSettings();
            provider = selection.optString("provider",
                    String.valueOf(settings.getOrDefault("defaultProvider", "")));
            model = selection.optString("model",
                    String.valueOf(settings.getOrDefault("defaultModel", "")));
            snapshot = queryStore.snapshot();
        } catch (Exception exception) {
            failure(t("无法读取 Pi 配置：") + exception.getMessage());
            return;
        }
        final String token = java.util.UUID.randomUUID().toString();
        thinkingLevelQueryToken = token;
        updateAgentControls();
        queryExecutor.execute(() -> {
            try {
                if (!ACTIVITY_EPOCH.owns(owner)) return;
                PiAgentBridge bridge = PiAgentBridge.get(this);
                final Object[] result = {null};
                final String[] error = {""};
                JSONObject arguments = new JSONObject().put("refresh", false);
                synchronized (thinkingLevelQueryLock) {
                    if (!ACTIVITY_EPOCH.owns(owner)) return;
                    thinkingLevelBridge = bridge;
                    thinkingLevelRequestId = bridge.query("catalog", snapshot, arguments, queryStore, event -> {
                        String type = event.optString("type");
                        if ("result".equals(type)) result[0] = event.opt("result");
                        else if ("error".equals(type)) error[0] = event.optString("message");
                        else if ("end".equals(type)) runOnUiThread(() -> {
                            if (!token.equals(thinkingLevelQueryToken)) return;
                            thinkingLevelQueryToken = null;
                            thinkingLevelBridge = null;
                            thinkingLevelRequestId = null;
                            updateAgentControls();
                            if (!ACTIVITY_EPOCH.owns(owner)
                                    || !conversationId.equals(chatStore.activeId())) return;
                            if (!thinkingSelectionMatches(conversationId, selectionSource,
                                    provider, model)) {
                                failure(t("模型或思考强度已更改，请重新选择"));
                                return;
                            }
                            if (!error[0].isEmpty()) { failure(error[0]); return; }
                            if (!(result[0] instanceof JSONArray)) {
                                failure(t("当前模型不在 SDK 模型目录中"));
                                return;
                            }
                            showThinkingLevelChoices((JSONArray) result[0], conversationId,
                                    provider, model, selectionSource, owner);
                        });
                    });
                }
            } catch (Exception exception) {
                runOnUiThread(() -> {
                    if (!token.equals(thinkingLevelQueryToken)) return;
                    thinkingLevelQueryToken = null;
                    thinkingLevelBridge = null;
                    thinkingLevelRequestId = null;
                    updateAgentControls();
                    if (ACTIVITY_EPOCH.owns(owner)) failure(exception.getMessage());
                });
            }
        });
    }

    private boolean thinkingSelectionMatches(String conversationId, String selectionSource,
            String providerId, String modelId) {
        if (!conversationId.equals(chatStore.activeId())
                || !selectionSource.equals(chatStore.piSelection())) return false;
        try {
            JSONObject selection = new JSONObject(selectionSource);
            java.util.Map<String, Object> settings = new PiConfigStore(this).effectiveSettings();
            String currentProvider = selection.optString("provider",
                    String.valueOf(settings.getOrDefault("defaultProvider", "")));
            String currentModel = selection.optString("model",
                    String.valueOf(settings.getOrDefault("defaultModel", "")));
            return providerId.equals(currentProvider) && modelId.equals(currentModel);
        } catch (Exception exception) { return false; }
    }

    private void showThinkingLevelChoices(JSONArray providers, String conversationId,
            String providerId, String modelId, String selectionSource, long owner) {
        JSONObject selectedModel = null;
        if (providers != null) for (int i = 0; i < providers.length(); i++) {
            JSONObject provider = providers.optJSONObject(i);
            if (provider == null || !providerId.equals(provider.optString("id"))) continue;
            JSONArray models = provider.optJSONArray("models");
            if (models == null) break;
            for (int j = 0; j < models.length(); j++) {
                JSONObject candidate = models.optJSONObject(j);
                if (candidate != null && modelId.equals(candidate.optString("id"))) {
                    selectedModel = candidate;
                    break;
                }
            }
            break;
        }
        if (selectedModel == null) {
            failure(t("当前模型不在 SDK 模型目录中"));
            return;
        }
        JSONArray levels = selectedModel.optJSONArray("thinkingLevels");
        if (levels == null) {
            failure(t("当前模型不在 SDK 模型目录中"));
            return;
        }
        String[] choices = new String[levels.length() + 1];
        choices[0] = t("继承默认强度");
        int checked = 0;
        String current;
        try { current = new JSONObject(selectionSource).optString("thinkingLevel", ""); }
        catch (Exception ignored) { current = ""; }
        for (int i = 0; i < levels.length(); i++) {
            choices[i + 1] = levels.optString(i);
            if (choices[i + 1].equals(current)) checked = i + 1;
        }
        final int checkedChoice = checked;
        new android.app.AlertDialog.Builder(this).setTitle(t("当前会话思考强度"))
                .setSingleChoiceItems(choices, checkedChoice, (dialog, which) -> {
                    if (!ACTIVITY_EPOCH.owns(owner)
                            || !conversationId.equals(chatStore.activeId())) {
                        dialog.dismiss();
                        return;
                    }
                    if (!thinkingSelectionMatches(conversationId, selectionSource,
                            providerId, modelId)) {
                        dialog.dismiss();
                        failure(t("模型或思考强度已更改，请重新选择"));
                        return;
                    }
                    try {
                        chatStore.setPiSelection(conversationId, providerId, modelId,
                                which == 0 ? null : choices[which]);
                        if (chatModelTitle != null) chatModelTitle.setText(currentModelLabel());
                        dialog.dismiss();
                    } catch (Exception exception) { failure(exception.getMessage()); }
                }).setNegativeButton(t("取消"), null).show();
    }

    private void startDictation() {
        if ("home".equals(page)) {
            openHomeInput(false);
            homeInputOverlay.select(2);
            voiceConversation = homeInputOverlay.draftId();
        } else voiceConversation = chatStore.activeId();
        String conversation = voiceConversation;
        VoiceManager.get(this).listen(this, conversation, new VoiceManager.Callback() {
            @Override public void onText(String text) { applyVoice(conversation, text); }
            @Override public void onError(String message) { failure(message); }
        });
    }

    private void applyVoice(String id, String words) {
        if (id == null) return;
        try {
            if (homeInputOverlay != null && id.equals(homeInputOverlay.draftId())) homeInputOverlay.appendVoice(words);
            else { chatStore.saveDraft(id, chatStore.draft(id) + words); refreshHomeComposer(); }
        } catch (Exception exception) { failure(exception.getMessage()); }
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        VoiceManager.get(this).onRequestPermissionsResult(this, request, results);
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (nativeSearchPage != null && nativeSearchPage.onActivityResult(request, result, data)) return;
        if (homeDesktop != null && homeDesktop.onActivityResult(request, result, data)) return;
        if (request == 42) { finishHomeAttachment(result, data); return; }
        if (request == 702 && result == RESULT_OK && data != null) {
            try {
                chatStore.setPiSelection(data.getStringExtra("provider"), data.getStringExtra("model"), data.getStringExtra("thinkingLevel"));
                if (chatModelTitle != null) chatModelTitle.setText(currentModelLabel());
            } catch (Exception exception) { Toast.makeText(this, exception.getMessage(), Toast.LENGTH_LONG).show(); }
        }
        if (request == VoiceManager.REQUEST_RECOGNIZER) VoiceManager.get(this).onActivityResult(request, result, data);
    }

    private boolean canChangeConversation() {
        if (!agentRunning) return true;
        Toast.makeText(this, t("请先停止此会话的当前生成"), Toast.LENGTH_SHORT).show();
        return false;
    }

    private void newConversation() {
        if (!chatStore.tree().nodes().isEmpty()) chatStore.newConversation();
        chatStore.saveDraft("");
        changeConversation();
    }

    private void changeConversation() {
        closeChatDrawer(false);
        agentRunning = chatCoordinator.running(chatStore.activeId());
        activePiRequestId = chatCoordinator.requestId();
        history = immutable(chatStore.load());
        expandedTools.clear();
        savedDraft = chatStore.draft();
        composerInput.setText(savedDraft);
        composerInput.setSelection(composerInput.length());
        savedChatScroll = 0;
        restoreChatScroll = false;
        showSearch();
    }

    private void closeChatDrawer() {
        closeChatDrawer(true);
    }

    private void closeChatDrawer(boolean animated) {
        if (chatDrawer == null || (drawerClosing && animated)) return;
        android.view.inputmethod.InputMethodManager keyboard = getSystemService(
                android.view.inputmethod.InputMethodManager.class);
        if (keyboard != null) keyboard.hideSoftInputFromWindow(root.getWindowToken(), 0);
        FrameLayout closing = chatDrawer;
        View scrim = closing.getChildAt(0);
        View panel = closing.getChildAt(1);
        scrim.animate().cancel();
        panel.animate().cancel();
        Runnable finish = () -> {
            root.removeView(closing);
            if (chatDrawer == closing) {
                chatDrawer = null;
                drawerClosing = false;
                pageShell.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);
            }
        };
        if (!animated || !android.animation.ValueAnimator.areAnimatorsEnabled()) {
            finish.run();
            return;
        }
        drawerClosing = true;
        panel.animate().translationX(-panel.getWidth()).setDuration(200)
                .setInterpolator(new android.view.animation.AccelerateDecelerateInterpolator()).start();
        scrim.animate().alpha(0).setDuration(200).withEndAction(finish).start();
    }

    private void showChatDrawer() {
        if (chatDrawer != null) return;
        android.view.inputmethod.InputMethodManager keyboard = getSystemService(
                android.view.inputmethod.InputMethodManager.class);
        if (keyboard != null) keyboard.hideSoftInputFromWindow(root.getWindowToken(), 0);
        pageShell.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        chatDrawer = new FrameLayout(this);
        View scrim = new View(this);
        scrim.setBackgroundColor(0x66000000);
        scrim.setContentDescription(t("关闭会话菜单"));
        scrim.setOnClickListener(view -> closeChatDrawer());
        chatDrawer.addView(scrim, match());
        LinearLayout drawer = column();
        drawer.setBackgroundColor(appearance.surface);
        drawer.setPadding(dp(12), dp(4), dp(12), dp(8));
        drawer.setClickable(true);
        int width = Math.min(dp(360), Math.round(getResources().getDisplayMetrics().widthPixels * .84f));
        FrameLayout.LayoutParams drawerParams = new FrameLayout.LayoutParams(width, -1, Gravity.LEFT);
        chatDrawer.addView(drawer, drawerParams);
        LinearLayout heading = row();
        TextView title = label("E Launcher", 20, CHARCOAL);
        title.setPadding(dp(8), 0, 0, 0);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        heading.addView(title, new LinearLayout.LayoutParams(0, dp(52), 1));
        title.setGravity(Gravity.CENTER_VERTICAL);
        heading.addView(chatIcon("close", t("关闭会话菜单"), view -> closeChatDrawer()));
        drawer.addView(heading);
        EditText query = new EditText(this);
        query.setTextSize(15);
        query.setSingleLine(true);
        query.setHint(t("搜索对话"));
        query.setContentDescription(t("搜索对话"));
        query.setTextColor(CHARCOAL);
        query.setHintTextColor(MUTED);
        query.setPadding(dp(18), 0, dp(16), 0);
        query.setBackground(shape(appearance.panel, 24, 0, 0));
        ChatIcon searchIcon = new ChatIcon("search", MUTED);
        searchIcon.setBounds(0, 0, dp(20), dp(20));
        query.setCompoundDrawables(searchIcon, null, null, null);
        query.setCompoundDrawablePadding(dp(12));
        LinearLayout.LayoutParams queryParams = new LinearLayout.LayoutParams(-1, dp(48));
        queryParams.setMargins(0, dp(12), 0, dp(12));
        drawer.addView(query, queryParams);
        drawer.addView(drawerAction("compose", t("新建对话"), view -> newConversation()));
        ScrollView scroll = new ScrollView(this);
        scroll.setVerticalScrollBarEnabled(false);
        LinearLayout entries = column();
        scroll.addView(entries);
        drawer.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        populateConversations(entries, "");
        query.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            public void onTextChanged(CharSequence s, int start, int before, int count) {
                populateConversations(entries, s.toString());
            }
            public void afterTextChanged(Editable value) { }
        });
        View divider = new View(this);
        divider.setBackgroundColor(appearance.border);
        drawer.addView(divider, new LinearLayout.LayoutParams(-1, dp(1)));
        drawer.addView(drawerAction("folder", t("已归档对话"), view -> {
            closeChatDrawer();
            showArchivedList();
        }));
        drawer.addView(drawerAction("home", t("返回桌面"), view -> showHome()));
        drawer.addView(drawerAction("settings", t("设置"), view -> {
            closeChatDrawer();
            new android.app.AlertDialog.Builder(this).setTitle(t("设置"))
                    .setItems(new String[]{t("模型与搜索服务"), t("桌面设置"), t("已归档对话"), t("永久删除当前对话")},
                            (dialog, which) -> {
                                if (which == 0) showProviderSettings();
                                else if (which == 1) openDesktopSettings();
                                else if (which == 2) showArchivedList();
                                else confirmDeleteConversation();
                            }).show();
        }));
        drawer.setFocusableInTouchMode(true);
        drawer.requestFocus();
        root.addView(chatDrawer, match());
        drawer.setTranslationX(-width);
        scrim.setAlpha(0f);
        drawer.animate().translationX(0).setDuration(motionDuration(260))
                .setInterpolator(new android.view.animation.DecelerateInterpolator()).start();
        scrim.animate().alpha(1f).setDuration(motionDuration(220)).start();
    }

    private LinearLayout drawerAction(String icon, String text, View.OnClickListener listener) {
        LinearLayout action = row();
        TextView symbol = chatIcon(icon, text, listener);
        symbol.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        symbol.setFocusable(false);
        symbol.setClickable(false);
        action.addView(symbol);
        action.addView(label(text, 16, CHARCOAL));
        action.setMinimumHeight(dp(52));
        action.setContentDescription(text);
        action.setFocusable(true);
        action.setOnClickListener(listener);
        pressFeedback(action);
        return action;
    }

    private void populateConversations(LinearLayout entries, String query) {
        entries.removeAllViews();
        String lastGroup = "";
        java.time.LocalDate today = java.time.LocalDate.now();
        for (ChatStore.Conversation conversation : chatStore.conversations()) {
            if (!conversation.title.toLowerCase(Locale.ROOT).contains(query.trim().toLowerCase(Locale.ROOT))) continue;
            java.time.LocalDate date = java.time.Instant.ofEpochMilli(conversation.updated)
                    .atZone(java.time.ZoneId.systemDefault()).toLocalDate();
            String group = date.equals(today) ? t("今天") : date.equals(today.minusDays(1)) ? t("昨天")
                    : !date.isBefore(today.minusDays(7)) ? t("过去 7 天") : t("更早");
            if (!group.equals(lastGroup)) {
                TextView section = label(group, 12, MUTED);
                section.setPadding(dp(12), dp(24), 0, dp(10));
                entries.addView(section);
                lastGroup = group;
            }
            LinearLayout item = row();
            boolean selected = conversation.id.equals(chatStore.activeId());
            if (selected) item.setBackground(shape(appearance.panel, 14, 0, 0));
            boolean running = chatCoordinator.running(conversation.id);
            TextView title = label(conversation.title + (running ? t(" · 正在运行") : ""), 15, CHARCOAL);
            title.setSingleLine(true);
            title.setEllipsize(android.text.TextUtils.TruncateAt.END);
            title.setPadding(dp(12), 0, dp(8), 0);
            title.setGravity(Gravity.CENTER_VERTICAL);
            title.setContentDescription(conversation.title + (selected ? t("，当前对话") : "")
                    + (running ? t("，正在运行") : ""));
            title.setFocusable(true);
            title.setOnClickListener(view -> {
                if (selected) { closeChatDrawer(); return; }
                chatStore.selectConversation(conversation.id);
                changeConversation();
            });
            item.addView(title, new LinearLayout.LayoutParams(0, dp(52), 1));
            item.addView(chatIcon("more", t("对话操作"), view -> showConversationActions(conversation)));
            entries.addView(item);
        }
        if (entries.getChildCount() == 0) {
            TextView empty = label(query.isEmpty() ? t("还没有历史对话") : t("没有找到匹配的对话"), 14, MUTED);
            empty.setPadding(dp(12), dp(24), dp(12), dp(24));
            entries.addView(empty);
        }
    }

    private void showConversationActions(ChatStore.Conversation conversation) {
        new android.app.AlertDialog.Builder(this).setTitle(conversation.title)
                .setItems(new String[]{t("归档"), t("永久删除")}, (dialog, which) -> {
                    if (which == 0) archiveConversation(conversation.id);
                    else confirmDeleteConversation(conversation.id);
                }).show();
    }

    private void confirmDeleteConversation() {
        confirmDeleteConversation(chatStore.activeId());
    }

    private void confirmDeleteConversation(String conversationId) {
        if (chatCoordinator.running(conversationId)) {
            Toast.makeText(this, t("此会话正在运行，请先停止后再删除"), Toast.LENGTH_SHORT).show();
            return;
        }
        ConversationArchiveUi.confirmPermanentDelete(this, () -> {
            boolean current = conversationId.equals(chatStore.activeId());
            if (current) {
                if (clearHistory()) changeConversation();
            } else {
                try { chatCoordinator.deleteConversation(conversationId); }
                catch (Exception exception) { failure(exception.getMessage()); return; }
                closeChatDrawer(false);
                refreshTaskCards();
            }
        });
    }

    private void archiveConversation(String conversationId) {
        if (conversationId == null || conversationId.isEmpty()) return;
        boolean current = conversationId.equals(chatStore.activeId());
        try { chatCoordinator.archiveConversation(conversationId); }
        catch (RuntimeException exception) { failure(exception.getMessage()); return; }
        closeChatDrawer(false);
        refreshTaskCards();
        if (current) {
            if (conversationId.equals(chatStore.activeId())) chatStore.newConversation();
            syncWebToActive();
            if (pager != null && pager.page() == PagerState.Page.CHAT) {
                agentRunning = chatCoordinator.running(chatStore.activeId());
                activePiRequestId = chatCoordinator.requestId();
                history = immutable(chatStore.load());
                expandedTools.clear();
                savedDraft = chatStore.draft();
                if (composerInput != null) {
                    composerInput.setText(savedDraft);
                    composerInput.setSelection(composerInput.length());
                }
            }
        }
        showArchiveUndo(conversationId);
    }

    private void syncWebToActive() {
        String route = "/chat/" + chatStore.activeId();
        initialWebRoute = route;
        if (chatWebView != null) chatWebView.evaluateJavascript("location.hash=" + JSONObject.quote("#" + route)
                + ";window.dispatchEvent(new Event('native-navigation'))", null);
    }

    private void showArchivedList() {
        ConversationArchiveUi.showList(this, chatCoordinator,
                id -> {
                    try { chatCoordinator.restoreConversation(id); refreshTaskCards(); }
                    catch (RuntimeException exception) { failure(exception.getMessage()); }
                },
                id -> {
                    try {
                        boolean current = id.equals(chatStore.activeId());
                        chatCoordinator.deleteConversation(id);
                        refreshTaskCards();
                        if (current) changeConversation();
                    } catch (RuntimeException exception) { failure(exception.getMessage()); }
                },
                this::openConversation);
    }

    private void showArchiveUndo(String conversationId) {
        if (root == null) return;
        ConversationArchiveUi.showUndo(root, t("对话已归档"), () -> {
            try {
                chatCoordinator.restoreConversation(conversationId);
                refreshTaskCards();
            } catch (RuntimeException exception) { failure(exception.getMessage()); }
        }, this);
    }

    private void sendMessage() {
        String text = composerInput == null ? "" : composerInput.getText().toString();
        String draftId = "home".equals(page) ? chatStore.homeDraftId() : chatStore.activeId();
        boolean hasAttachments = draftId != null && !chatStore.draftAttachments(draftId).isEmpty();
        if (text.trim().isEmpty() && !hasAttachments) return;
        if (!"home".equals(page) && chatStore.isArchived(chatStore.activeId())) {
            String archivedId = chatStore.activeId();
            ConversationArchiveUi.promptArchived(this, archivedAt(archivedId),
                    () -> {
                        try {
                            chatCoordinator.restoreConversation(archivedId);
                            refreshTaskCards();
                            sendMessage();
                        } catch (RuntimeException exception) { failure(exception.getMessage()); }
                    }, null);
            return;
        }
        if ("home".equals(page)) {
            if (nativeAttachmentBusy || (homeInputOverlay != null && !homeInputOverlay.canSend())) return;
            try {
                chatStore.selectHomeDraft();
                chatStore.saveDraft(text);
                String id = chatStore.activeId();
                String accepted = chatCoordinator.send(id, text, java.util.UUID.randomUUID().toString());
                if (accepted != null) launchWeb("/chat/" + id, null, null);
            } catch (Exception exception) { failure(exception.getMessage()); }
            return;
        }
        if (chatCoordinator.running(chatStore.activeId()) || thinkingLevelQueryToken != null) return;
        try { chatCoordinator.send(text, null); }
        catch (Exception exception) { failure(exception.getMessage()); }
    }

    private void cancelAgent() { chatCoordinator.cancel(chatStore.activeId()); }

    private void savePiPreview() { }

    private void updateAgentControls() {
        if (homeInputOverlay != null) { homeInputOverlay.updateControls(); return; }
        boolean home = "home".equals(page);
        if (sendButton != null) {
            boolean hasContent = composerInput != null
                    && (!composerInput.getText().toString().trim().isEmpty()
                            || (home ? chatStore.homeDraftId() != null
                                    && !chatStore.draftAttachments(chatStore.homeDraftId()).isEmpty()
                                    : !chatStore.draftAttachments().isEmpty()));
            boolean enabled = hasContent && (home || (!agentRunning && thinkingLevelQueryToken == null));
            sendButton.setEnabled(enabled);
            sendButton.setAlpha(enabled ? 1f : .35f);
            sendButton.setVisibility(home || !agentRunning ? View.VISIBLE : View.GONE);
        }
        if (stopButton != null) {
            stopButton.setEnabled(!home && agentRunning);
            stopButton.setVisibility(!home && agentRunning ? View.VISIBLE : View.GONE);
        }
        if (thinkingLevelButton != null) {
            boolean enabled = !agentRunning && thinkingLevelQueryToken == null;
            thinkingLevelButton.setEnabled(enabled);
            thinkingLevelButton.setAlpha(enabled ? 1f : .35f);
        }
        if (state != null && agentRunning && state.getText().length() == 0) {
            state.setText(t("正在等待助手…"));
        }
    }

    private static List<AgentLoop.Message> immutable(List<AgentLoop.Message> source) {
        return Collections.unmodifiableList(new ArrayList<>(source));
    }

    private void showSnapshot(List<AgentLoop.Message> snapshot) {
        history = snapshot;
        if (state != null && agentRunning) state.setText(runningStatus(snapshot));
        renderMessages();
    }

    private void updatePiPreview(List<AgentLoop.Message> work, String text) {
        List<AgentLoop.Message> preview = new ArrayList<>(work);
        AgentLoop.Message message = new AgentLoop.Message(activePiMessageId, "assistant", text,
                null, Collections.emptyList(), true);
        preview.add(message);
        if (piStreamingBody == null || !(piStreamingBody.getParent() instanceof View)
                || ((View) piStreamingBody.getParent()).getParent() != messageList) {
            showSnapshot(immutable(preview));
            return;
        }
        boolean follow = forceScrollToBottom || pendingScrollToBottom || nearLatest();
        if (follow) pendingScrollToBottom = true;
        forceScrollToBottom = false;
        long generation = ++renderGeneration;
        history = immutable(preview);
        if (state != null && agentRunning) state.setText(runningStatus(history));
        markdown.setMarkdown(piStreamingBody, text);
        // Keep finalization's content key current without recreating the bubble or its animation.
        ((View) piStreamingBody.getParent()).setTag(messageKey(message, piStreamingVisibleIndex));
        ScrollView current = messageScroll;
        if (current != null && follow) current.post(() -> {
            if (messageScroll == current && "search".equals(page)
                    && generation == renderGeneration) scrollToLatest();
        });
        if (newerMessages != null) newerMessages.setVisibility(follow ? View.GONE : View.VISIBLE);
    }

    private void renderMessages() {
        piStreamingBody = null;
        if (messageList == null) return;
        boolean follow = forceScrollToBottom || pendingScrollToBottom || nearLatest();
        if (follow) pendingScrollToBottom = true;
        forceScrollToBottom = false;
        long generation = ++renderGeneration;
        ScrollAnchor anchor = follow ? null : visibleAnchor();
        boolean hadContent = messageList.getChildCount() > 0;
        Set<Object> previousMessages = new HashSet<>();
        for (int index = 0; index < messageList.getChildCount(); index++) {
            previousMessages.add(messageList.getChildAt(index).getTag());
        }
        messageList.removeAllViews();
        int visibleIndex = 0;
        for (int historyIndex = 0; historyIndex < history.size(); historyIndex++) {
            AgentLoop.Message message = history.get(historyIndex);
            if ("system".equals(message.role) || "tool".equals(message.role)) continue;
            boolean user = "user".equals(message.role);
            LinearLayout bubble = column();
            if (user) {
                bubble.setBackground(shape(appearance.panel, 22, 0, 0));
                bubble.setPadding(dp(16), dp(12), dp(16), dp(12));
            }
            String messageKey = messageKey(message, visibleIndex++);
            bubble.setTag(messageKey);
            String content = message.content == null ? "" : message.content;
            TextView body = label("", 16, CHARCOAL);
            body.setTextIsSelectable(true);
            if (user) body.setText(content);
            else markdown.setMarkdown(body, content);
            body.setLineSpacing(dp(5), 1f);
            body.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
            bubble.addView(body);
            boolean streaming = agentRunning && activePiRequestId != null && !user
                    && historyIndex == history.size() - 1;
            if (streaming) {
                piStreamingBody = body;
                piStreamingVisibleIndex = visibleIndex - 1;
            }
            for (int callIndex = 0; callIndex < message.toolCalls.size(); callIndex++) {
                addToolResult(bubble, message.toolCalls.get(callIndex), historyIndex,
                        messageKey + ":tool:" + callIndex);
            }
            if (!user && !streaming && message.incomplete) {
                TextView interrupted = label(t("回复未完成 · 已保留生成内容"), 12, MUTED);
                interrupted.setPadding(0, dp(8), 0, 0);
                bubble.addView(interrupted);
            }
            if (!user && !streaming && !content.isEmpty()) {
                LinearLayout actions = row();
                actions.setPadding(0, dp(8), 0, 0);
                actions.addView(chatIcon("copy", t("复制回复"), view -> {
                    android.content.ClipboardManager clipboard = getSystemService(
                            android.content.ClipboardManager.class);
                    clipboard.setPrimaryClip(android.content.ClipData.newPlainText(t("助手回复"), content));
                    Toast.makeText(this, t("已复制"), Toast.LENGTH_SHORT).show();
                }));
                actions.addView(chatIcon("share", t("分享回复"), view -> launch(Intent.createChooser(
                        new Intent(Intent.ACTION_SEND).setType("text/plain")
                                .putExtra(Intent.EXTRA_TEXT, content), t("分享回复")))));
                bubble.addView(actions);
            }
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(user ? -2 : -1, -2);
            params.gravity = user ? Gravity.END : Gravity.START;
            if (user) params.leftMargin = dp(32);
            params.bottomMargin = dp(28);
            messageList.addView(bubble, params);
            if (hadContent && follow && !previousMessages.contains(messageKey)
                    && historyIndex >= history.size() - 2) enterMotion(bubble, 12);
        }
        messageList.setGravity(messageList.getChildCount() == 0 ? Gravity.CENTER : Gravity.TOP);
        if (messageList.getChildCount() == 0) {
            LinearLayout empty = column();
            empty.setGravity(Gravity.CENTER);
            empty.setTag("empty");
            TextView greeting = label(t("有什么可以帮你？"), 28, CHARCOAL);
            greeting.setTypeface(null, android.graphics.Typeface.BOLD);
            greeting.setGravity(Gravity.CENTER);
            empty.addView(greeting);
            TextView subtitle = label(t("提问、整理思路，或开始一个新任务"), 14, MUTED);
            subtitle.setGravity(Gravity.CENTER);
            subtitle.setPadding(0, dp(12), 0, dp(28));
            empty.addView(subtitle);
            LinearLayout suggestions = row();
            for (String suggestion : new String[]{t("整理今天的安排"), t("帮我写一段文字")}) {
                TextView chip = label(suggestion, 13, CHARCOAL);
                chip.setGravity(Gravity.CENTER);
                chip.setPadding(dp(8), dp(12), dp(8), dp(12));
                chip.setMinHeight(dp(48));
                chip.setBackground(shape(appearance.surface, 24, 1, appearance.border));
                chip.setOnClickListener(view -> {
                    composerInput.setText(suggestion);
                    composerInput.setSelection(composerInput.length());
                    composerInput.requestFocus();
                });
                chip.setFocusable(true);
                pressFeedback(chip);
                LinearLayout.LayoutParams chipParams = new LinearLayout.LayoutParams(0, -2, 1);
                chipParams.setMargins(dp(4), 0, dp(4), 0);
                suggestions.addView(chip, chipParams);
            }
            empty.addView(suggestions);
            messageList.addView(empty, new LinearLayout.LayoutParams(-1, -2));
        }
        ScrollView current = messageScroll;
        if (current == null) return;
        current.post(() -> {
            if (messageScroll != current || !"search".equals(page)
                    || generation != renderGeneration) return;
            if (follow) scrollToLatest(); else restoreAnchor(anchor);
        });
        if (newerMessages != null) newerMessages.setVisibility(follow ? View.GONE : View.VISIBLE);
    }

    private void addToolResult(LinearLayout bubble, AgentLoop.ToolCall call, int assistantIndex,
            String expansionKey) {
        AgentLoop.Message result = AgentHistory.toolResultAfter(history, assistantIndex, call.id);
        String resultText = result == null || result.content == null ? "" : result.content;
        TextView summary = label("▸ " + toolLabel(call.name) + " · "
                + toolOutcome(call.name, resultText), 14, TEAL);
        summary.setMinHeight(dp(48));
        summary.setGravity(Gravity.CENTER_VERTICAL);
        summary.setClickable(true);
        summary.setFocusable(true);
        String detailText = t("参数\n") + displayText(call.arguments, 1200)
                + (result == null ? "" : t("\n\n结果\n") + displayText(resultText, 4000));
        TextView detail = label(detailText, 13, MUTED);
        detail.setTextIsSelectable(true);
        detail.setPadding(dp(12), 0, 0, dp(8));
        boolean expanded = expandedTools.contains(expansionKey);
        detail.setVisibility(expanded ? View.VISIBLE : View.GONE);
        summary.setText((expanded ? "▾ " : "▸ ") + toolLabel(call.name) + " · "
                + toolOutcome(call.name, resultText));
        summary.setContentDescription((expanded ? t("收起") : t("展开")) + toolLabel(call.name)
                + t("详情，") + toolOutcome(call.name, resultText));
        summary.setOnClickListener(view -> {
            boolean expand = detail.getVisibility() != View.VISIBLE;
            animateExpansion(bubble);
            detail.setVisibility(expand ? View.VISIBLE : View.GONE);
            if (expand) expandedTools.add(expansionKey); else expandedTools.remove(expansionKey);
            summary.setText((expand ? "▾ " : "▸ ") + toolLabel(call.name) + " · "
                    + toolOutcome(call.name, resultText));
            summary.setContentDescription((expand ? t("收起") : t("展开")) + toolLabel(call.name)
                    + t("详情，") + toolOutcome(call.name, resultText));
        });
        bubble.addView(summary);
        bubble.addView(detail);
    }

    private String toolOutcome(String name, String result) {
        if (result.isEmpty()) return t("正在执行");
        if (result.contains("\"ok\":false") || result.startsWith("Tool failed")
                || result.startsWith("Tool unavailable") || result.startsWith("Tool cancelled")) {
            return t("错误 · ") + displayText(result, 100).replace('\n', ' ');
        }
        if ("read_screen".equals(name)) try {
            org.json.JSONObject value = new org.json.JSONObject(result);
            org.json.JSONArray nodes = value.optJSONArray("nodes");
            return t("成功 · ") + (nodes == null ? 0 : nodes.length()) + t(" 个节点")
                    + (value.optBoolean("truncated") ? t(" · 已截断") : "");
        } catch (org.json.JSONException ignored) { }
        return t("成功");
    }

    private String toolLabel(String name) {
        switch (name) {
            case "read_screen": return t("读取屏幕");
            case "click": return t("点击节点");
            case "input_text": return t("输入文字");
            case "scroll": return t("滚动界面");
            case "launch_app": return t("启动应用");
            case "list_apps": return t("列出应用");
            case "web_search": return t("网页搜索");
            case "web_fetch": return t("读取网页");
            case "back": return t("返回");
            case "home": return t("回到桌面");
            case "recents": return t("最近任务");
            default: return name;
        }
    }

    private String displayText(String value, int limit) {
        if (value == null) return "";
        return value.length() <= limit ? value
                : value.substring(0, limit) + t("\n…（详情显示已截断）");
    }

    private static String messageKey(AgentLoop.Message message, int index) {
        int fingerprint = message.content == null ? 0 : message.content.hashCode();
        for (AgentLoop.ToolCall call : message.toolCalls) {
            fingerprint = 31 * fingerprint + call.id.hashCode();
            fingerprint = 31 * fingerprint + call.name.hashCode();
            fingerprint = 31 * fingerprint + call.arguments.hashCode();
        }
        return message.role + ":" + index + ":" + fingerprint;
    }

    private String runningStatus(List<AgentLoop.Message> snapshot) {
        if (!snapshot.isEmpty()) {
            AgentLoop.Message last = snapshot.get(snapshot.size() - 1);
            if (!last.toolCalls.isEmpty()) {
                return t("正在") + toolLabel(last.toolCalls.get(last.toolCalls.size() - 1).name) + "…";
            }
            if ("tool".equals(last.role)) return t("正在等待助手…");
        }
        return t("正在思考…");
    }

    private boolean nearLatest() {
        if (messageScroll == null || messageScroll.getChildCount() == 0) return true;
        int remaining = messageScroll.getChildAt(0).getHeight()
                - messageScroll.getHeight() - messageScroll.getScrollY();
        return remaining <= dp(64);
    }

    private ScrollAnchor visibleAnchor() {
        if (messageList == null || messageScroll == null) return null;
        int scrollY = messageScroll.getScrollY();
        for (int index = 0; index < messageList.getChildCount(); index++) {
            View child = messageList.getChildAt(index);
            if (child.getBottom() > scrollY) {
                return new ScrollAnchor(child.getTag(), child.getTop() - scrollY);
            }
        }
        return null;
    }

    private void restoreAnchor(ScrollAnchor anchor) {
        if (anchor == null || messageList == null || messageScroll == null) return;
        for (int index = 0; index < messageList.getChildCount(); index++) {
            View child = messageList.getChildAt(index);
            if (anchor.key == null ? child.getTag() == null : anchor.key.equals(child.getTag())) {
                messageScroll.scrollTo(0, child.getTop() - anchor.offset);
                return;
            }
        }
    }

    private void scrollToLatest() {
        if (messageScroll == null || messageScroll.getChildCount() == 0) return;
        pendingScrollToBottom = false;
        int bottom = Math.max(0, messageScroll.getChildAt(0).getHeight()
                - messageScroll.getHeight());
        messageScroll.scrollTo(0, bottom);
        if (newerMessages != null) newerMessages.setVisibility(View.GONE);
    }

    private static final class ScrollAnchor {
        final Object key;
        final int offset;

        ScrollAnchor(Object key, int offset) {
            this.key = key;
            this.offset = offset;
        }
    }

    private boolean clearHistory() {
        try { chatCoordinator.deleteConversation(chatStore.activeId()); }
        catch (Exception exception) { failure(exception.getMessage()); return false; }
        history = Collections.emptyList();
        expandedTools.clear();
        forceScrollToBottom = true;
        renderMessages();
        if (state != null) state.setText(t("记录已清空"));
        return true;
    }

    private String currentModelLabel() {
        try {
            JSONObject selection = new JSONObject(chatStore.piSelection());
            String model = selection.optString("model", "");
            if (model.isEmpty()) model = String.valueOf(new PiConfigStore(this).effectiveSettings().getOrDefault("defaultModel", t("选择模型")));
            return model + " · " + selection.optString("thinkingLevel", "默认") + " ⌄";
        } catch (Exception exception) { return t("选择模型 ⌄"); }
    }

    private void showProviderSettings() {
        launchWeb("/settings", null, null);
    }

    private void launch(Intent intent) {
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException | SecurityException exception) {
            failure(t("无法打开：") + exception.getClass().getSimpleName()
                    + t("。请从系统设置手动操作；应用也可能已被卸载或禁用。"));
        }
    }

    private void failure(String message) {
        if (state != null) state.setText(message);
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
    }


    private void updateClock() {
        Date now = new Date();
        if (clock != null) clock.setText(new SimpleDateFormat("HH:mm", Locale.getDefault()).format(now));
        if (date != null) date.setText(new SimpleDateFormat(t("EEEE，M月d日"), getResources().getConfiguration().getLocales().get(0)).format(now));
    }

    private LinearLayout column() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        return layout;
    }

    private LinearLayout row() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.HORIZONTAL);
        layout.setGravity(Gravity.CENTER_VERTICAL);
        return layout;
    }

    private TextView label(String value, int size, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        return view;
    }

    private TextView pill(String value, View.OnClickListener listener) {
        TextView view = roundedText(value, 15, TEAL, 0x14267A69, 24);
        view.setGravity(Gravity.CENTER);
        view.setMinWidth(dp(48));
        view.setMinHeight(dp(48));
        view.setPadding(dp(15), 0, dp(15), 0);
        view.setClickable(true);
        view.setFocusable(true);
        view.setOnClickListener(listener);
        pressFeedback(view);
        return view;
    }

    private TextView roundedText(String value, int size, int color, int background, int radius) {
        TextView view = label(value, size, color);
        view.setBackground(shape(background, radius, 0, 0));
        return view;
    }

    private GradientDrawable shape(int color, int radiusDp, int strokeDp, int strokeColor) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(radiusDp));
        if (strokeDp > 0) drawable.setStroke(dp(strokeDp), strokeColor);
        return drawable;
    }

    private FrameLayout.LayoutParams match() {
        return new FrameLayout.LayoutParams(-1, -1);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private View createWallpaper() { return appearance.wallpaper(this); }
}
