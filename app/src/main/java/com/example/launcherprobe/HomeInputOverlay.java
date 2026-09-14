package com.example.launcherprobe;

import android.content.Context;
import android.content.pm.ResolveInfo;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.text.InputType;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.widget.BaseAdapter;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

/** Native search/composition above HOME. Only an explicit send or history click opens chat. */
final class HomeInputOverlay extends LinearLayout {
    private final ChatStore store;
    private final PagerRoot pager;
    private final EditText input;
    private final View plus, voice, send;
    private final AppAppearance colors;
    private final List<ResolveInfo> apps;
    private final List<ResolveInfo> matchingApps = new ArrayList<>();
    private List<ChatStore.Conversation> conversations = new ArrayList<>();
    private List<ChatAttachment> attachments = new ArrayList<>();
    private final Consumer<String> openConversation;
    private final String[] values = {"", "", ""};
    private final TextView[] tabs = new TextView[3];
    private final TextView empty;
    private final BaseAdapter adapter;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService search = Executors.newSingleThreadExecutor();
    private final String draftId;
    private int tab = 2, generation;
    private boolean binding, closed, preparing;
    private Runnable pendingSearch;
    private final TextWatcher watcher;

    HomeInputOverlay(Context context, PagerRoot pager, ChatStore store, List<ResolveInfo> apps,
            View composer, EditText input, View plus, View voice, View send,
            Consumer<String> openConversation, Runnable submit) {
        super(context);
        this.store = store; this.pager = pager; this.apps = apps;
        this.input = input; this.plus = plus; this.voice = voice; this.send = send;
        this.openConversation = openConversation;
        colors = AppAppearance.read(context);
        draftId = store.prepareHomeDraft();
        values[2] = store.draft(draftId);
        setOrientation(VERTICAL);
        setBackgroundColor(colors.background);
        setClickable(true);
        addView(composer, new LayoutParams(-1, -2));
        LinearLayout labels = new LinearLayout(context);
        labels.setPadding(dp(20), dp(4), dp(20), dp(8));
        for (int i = 0; i < tabs.length; i++) {
            final int selected = i;
            TextView label = text(new String[]{t("应用搜索", "Apps"), t("对话历史", "History"), t("新建对话", "New chat")}[i], 15);
            label.setGravity(Gravity.CENTER); label.setMinHeight(dp(48));
            label.setFocusable(true); label.setOnClickListener(v -> select(selected));
            tabs[i] = label;
            labels.addView(label, new LayoutParams(0, -2, 1));
        }
        addView(labels);
        empty = text("", 14); empty.setGravity(Gravity.CENTER); empty.setPadding(dp(20), dp(20), dp(20), dp(20));
        addView(empty);
        ListView results = new ListView(context);
        results.setDivider(null); results.setPadding(dp(20), 0, dp(20), 0);
        results.setClipToPadding(false); results.setEmptyView(empty);
        adapter = new BaseAdapter() {
            @Override public int getCount() { return tab == 0 ? matchingApps.size() : tab == 1 ? conversations.size() : attachments.size(); }
            @Override public Object getItem(int position) { return tab == 0 ? matchingApps.get(position) : tab == 1 ? conversations.get(position) : attachments.get(position); }
            @Override public long getItemId(int position) { return position; }
            @Override public View getView(int position, View recycled, ViewGroup parent) {
                Row row = recycled instanceof Row ? (Row) recycled : new Row();
                row.icon.setImageDrawable(null); row.icon.setVisibility(GONE);
                row.remove.setVisibility(GONE); row.detail.setText("");
                if (tab == 0) {
                    ResolveInfo app = matchingApps.get(position);
                    row.title.setText(app.loadLabel(context.getPackageManager()));
                    row.detail.setText(app.activityInfo.packageName);
                    row.icon.setImageDrawable(app.loadIcon(context.getPackageManager())); row.icon.setVisibility(VISIBLE);
                } else if (tab == 1) {
                    ChatStore.Conversation item = conversations.get(position);
                    row.title.setText(item.title);
                    row.detail.setText(item.snippet != null ? item.snippet
                            : android.text.format.DateUtils.getRelativeTimeSpanString(item.updated));
                } else {
                    ChatAttachment item = attachments.get(position);
                    row.title.setText(item.name);
                    row.detail.setText(android.text.format.Formatter.formatShortFileSize(context, item.size));
                    row.icon.setImageDrawable(new ChatIcon("image".equals(item.kind) ? "camera" : "file", colors.accent));
                    row.icon.setVisibility(VISIBLE);
                    row.remove.setVisibility(VISIBLE);
                    row.remove.setContentDescription(t("移除附件 ", "Remove attachment ") + item.name);
                    row.remove.setOnClickListener(v -> {
                        store.removeDraftAttachment(draftId, item.id); refreshAttachments();
                    });
                }
                return row;
            }
        };
        results.setAdapter(adapter);
        results.setOnItemClickListener((parent, view, position, id) -> {
            try {
                if (tab == 0) {
                    ResolveInfo app = matchingApps.get(position);
                    DeviceActions.launch(context, app.activityInfo.packageName, app.activityInfo.name);
                } else if (tab == 1) openConversation.accept(conversations.get(position).id);
            } catch (Exception error) { error(error.getMessage()); }
        });
        addView(results, new LayoutParams(-1, 0, 1));
        watcher = new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            @Override public void afterTextChanged(Editable value) { }
            @Override public void onTextChanged(CharSequence value, int start, int before, int count) {
                if (binding || closed) return;
                values[tab] = value.toString();
                if (tab == 2) store.saveDraft(draftId, values[2]);
                else searchResults();
                updateControls();
            }
        };
        input.addTextChangedListener(watcher);
        input.setOnEditorActionListener((v, action, event) -> {
            if (action == EditorInfo.IME_ACTION_SEND && tab == 2) { submit.run(); return true; }
            if (action == EditorInfo.IME_ACTION_SEARCH) { searchResults(); return true; }
            return false;
        });
        select(2);
    }

    void save(android.os.Bundle state) {
        state.putInt("home_input_tab", tab);
    }
    void restore(android.os.Bundle state) {
        select(Math.max(0, Math.min(2, state.getInt("home_input_tab", 2))));
    }

    String draftId() { return draftId; }
    boolean canSend() { return tab == 2 && !preparing && (!values[2].trim().isEmpty() || !attachments.isEmpty()); }
    int selectedTab() { return tab; }
    void setPreparing(boolean value) { preparing = value; updateControls(); }

    void select(int value) {
        binding = true;
        android.view.inputmethod.InputMethodManager keyboard = getContext().getSystemService(android.view.inputmethod.InputMethodManager.class);
        input.clearFocus();
        tab = value;
        input.setInputType(InputType.TYPE_CLASS_TEXT | (tab == 2 ? InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES : 0));
        input.setFocusableInTouchMode(true);
        input.setSingleLine(tab != 2); input.setMaxLines(tab == 2 ? 4 : 1);
        input.setImeOptions(tab == 2 ? EditorInfo.IME_ACTION_SEND : EditorInfo.IME_ACTION_SEARCH);
        input.setText(values[tab]); input.setSelection(input.length());
        input.setHint(tab == 0 ? t("搜索应用…", "Search apps…") : tab == 1 ? t("搜索标题或消息正文…", "Search conversations…") : t("发消息…", "Message…"));
        input.setContentDescription(input.getHint()); input.setCursorVisible(true);
        input.setShowSoftInputOnFocus(true);
        binding = false;
        for (int i = 0; i < tabs.length; i++) {
            boolean active = i == tab;
            tabs[i].setSelected(active);
            tabs[i].setTextColor(active ? colors.accent : colors.muted);
            tabs[i].setTypeface(null, active ? Typeface.BOLD : Typeface.NORMAL);
            GradientDrawable underline = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                    new int[]{Color.TRANSPARENT, Color.TRANSPARENT});
            // A bottom inset avoids introducing filled pills into the existing tab style.
            android.graphics.drawable.ShapeDrawable line = new android.graphics.drawable.ShapeDrawable();
            line.getPaint().setColor(active ? colors.accent : colors.border);
            android.graphics.drawable.LayerDrawable background = new android.graphics.drawable.LayerDrawable(new android.graphics.drawable.Drawable[]{underline, line});
            background.setLayerHeight(1, dp(active ? 2 : 1)); background.setLayerGravity(1, Gravity.BOTTOM);
            tabs[i].setBackground(background);
        }
        refreshAttachments(); searchResults(); updateControls();
        input.requestFocus();
        keyboard.restartInput(input);
    }

    void refreshAttachments() {
        attachments = store.draftAttachments(draftId);
        if (tab == 2) { adapter.notifyDataSetChanged(); empty.setText(""); }
        updateControls();
    }

    void appendVoice(String words) {
        select(2);
        input.setText(values[2] + words);
        input.setSelection(input.length());
    }

    void updateControls() {
        plus.setVisibility(tab == 2 ? VISIBLE : GONE);
        voice.setVisibility(tab == 2 ? VISIBLE : GONE);
        send.setVisibility(tab == 2 ? VISIBLE : GONE);
        plus.setEnabled(!preparing);
        send.setEnabled(canSend()); send.setAlpha(canSend() ? 1f : .35f);
    }

    private void searchResults() {
        int request = ++generation;
        if (pendingSearch != null) main.removeCallbacks(pendingSearch);
        if (tab == 0) {
            matchingApps.clear();
            boolean blank = values[0].trim().isEmpty();
            if (!blank) {
                for (ResolveInfo app : apps) if (AppSearch.matches(app.loadLabel(getContext().getPackageManager()).toString(), app.activityInfo.packageName, values[0])) matchingApps.add(app);
            }
            empty.setText(blank ? "" : t("没有找到应用", "No apps found")); adapter.notifyDataSetChanged();
        } else if (tab == 1) {
            String query = values[1];
            conversations = new ArrayList<>(); adapter.notifyDataSetChanged();
            empty.setText(t("正在搜索…", "Searching…"));
            pendingSearch = () -> search.execute(() -> {
                try {
                    List<ChatStore.Conversation> result = store.conversations(query);
                    main.post(() -> {
                        if (closed || request != generation) return;
                        conversations = result; empty.setText(t("没有找到对话", "No conversations found")); adapter.notifyDataSetChanged();
                    });
                } catch (Exception failure) { main.post(() -> { if (!closed && request == generation) error(failure.getMessage()); }); }
            });
            main.postDelayed(pendingSearch, 120);
        } else { empty.setText(""); adapter.notifyDataSetChanged(); }
    }

    private void error(String message) { android.widget.Toast.makeText(getContext(), message, android.widget.Toast.LENGTH_LONG).show(); }

    void clearInput() {
        values[0] = values[1] = values[2] = "";
        store.saveDraft(draftId, "");
        binding = true;
        input.setText("");
        binding = false;
        searchResults();
        updateControls();
    }

    void dispose() {
        closed = true; generation++;
        if (pendingSearch != null) main.removeCallbacks(pendingSearch);
        search.shutdownNow(); input.removeTextChangedListener(watcher); input.setOnEditorActionListener(null);
    }

    @Override public boolean dispatchTouchEvent(MotionEvent event) {
        if (event.getActionMasked() == MotionEvent.ACTION_DOWN) pager.setGestureBlocked(pager.gestureId(), true);
        return super.dispatchTouchEvent(event);
    }

    private final class Row extends LinearLayout {
        final ImageView icon;
        final TextView title, detail, remove;
        Row() {
            super(HomeInputOverlay.this.getContext());
            setGravity(Gravity.CENTER_VERTICAL); setPadding(dp(8), dp(10), dp(4), dp(10)); setMinimumHeight(dp(76));
            icon = new ImageView(getContext()); addView(icon, new LayoutParams(dp(40), dp(40)));
            LinearLayout copy = new LinearLayout(getContext()); copy.setOrientation(VERTICAL); copy.setPadding(dp(12), 0, dp(8), 0);
            title = text("", 16); title.setMaxLines(2); title.setEllipsize(android.text.TextUtils.TruncateAt.END);
            detail = text("", 12); detail.setTextColor(colors.muted); detail.setMaxLines(2);
            copy.addView(title); copy.addView(detail); addView(copy, new LayoutParams(0, -2, 1));
            remove = text("×", 24); remove.setGravity(Gravity.CENTER); remove.setFocusable(false);
            addView(remove, new LayoutParams(dp(44), dp(44)));
        }
    }
    private TextView text(String value, int size) { TextView view = new TextView(getContext()); view.setText(value); view.setTextSize(size); view.setTextColor(colors.ink); return view; }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private String t(String zh, String en) { return getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh") ? zh : en; }
}
