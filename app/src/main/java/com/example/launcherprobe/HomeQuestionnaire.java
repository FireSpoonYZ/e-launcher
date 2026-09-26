package com.example.launcherprobe;

import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

/** Live task questionnaire. Drafts belong to the detail host, not the rendered views. */
final class HomeQuestionnaire extends LinearLayout {
    interface Reply {
        void send(String conversationId, String requestId, String questionnaireId,
                JSONArray answers, boolean cancelled) throws Exception;
    }

    static final class Answer {
        String kind = "";
        String text = "";
        final Set<String> selected = new LinkedHashSet<>();
    }

    static final class Draft {
        final String requestId, questionnaireId;
        final Map<Integer, Answer> answers = new HashMap<>();
        int page;
        String error = "";

        Draft(JSONObject card) {
            requestId = card.optString("requestId");
            questionnaireId = card.optJSONObject("askUser").optString("id");
        }

        boolean matches(JSONObject card) {
            JSONObject question = liveQuestion(card);
            return question != null && requestId.equals(card.optString("requestId"))
                    && questionnaireId.equals(question.optString("id"));
        }

        android.os.Bundle save() {
            android.os.Bundle state = new android.os.Bundle();
            state.putString("request", requestId); state.putString("questionnaire", questionnaireId); state.putInt("page", page);
            for (Map.Entry<Integer, Answer> entry : answers.entrySet()) {
                Answer answer = entry.getValue(); android.os.Bundle value = new android.os.Bundle();
                value.putString("kind", answer.kind); value.putString("text", answer.text);
                value.putStringArrayList("selected", new java.util.ArrayList<>(answer.selected));
                state.putBundle("answer:" + entry.getKey(), value);
            }
            return state;
        }

        void restore(android.os.Bundle state) {
            if (state == null || !requestId.equals(state.getString("request"))
                    || !questionnaireId.equals(state.getString("questionnaire"))) return;
            page = state.getInt("page");
            for (String key : state.keySet()) if (key.startsWith("answer:")) {
                android.os.Bundle value = state.getBundle(key);
                Answer answer = answer(Integer.parseInt(key.substring(7)));
                answer.kind = value.getString("kind", ""); answer.text = value.getString("text", "");
                answer.selected.addAll(value.getStringArrayList("selected"));
            }
        }

        Answer answer(int index) { return answers.computeIfAbsent(index, ignored -> new Answer()); }

        void choose(JSONObject question, String label) {
            Answer answer = answer(question.optInt("questionIndex"));
            boolean multi = question.optBoolean("multiSelect");
            if (!multi) {
                answer.kind = "option";
                answer.text = label;
                answer.selected.clear();
            } else {
                if (!"multi".equals(answer.kind)) answer.selected.clear();
                answer.kind = "multi";
                if (!answer.selected.remove(label)) answer.selected.add(label);
            }
        }

        JSONArray result(JSONArray questions) throws JSONException {
            JSONArray result = new JSONArray();
            for (int i = 0; i < questions.length(); i++) {
                JSONObject question = questions.getJSONObject(i);
                int index = question.getInt("questionIndex");
                Answer answer = answers.get(index);
                if (answer == null || answer.kind.isEmpty()) continue;
                JSONObject value = new JSONObject().put("questionIndex", index).put("kind", answer.kind);
                if ("multi".equals(answer.kind)) {
                    JSONArray selected = new JSONArray();
                    JSONArray options = question.getJSONArray("options");
                    for (int j = 0; j < options.length(); j++) {
                        String label = options.getJSONObject(j).getString("label");
                        if (answer.selected.contains(label)) selected.put(label);
                    }
                    if (selected.length() == 0) continue;
                    value.put("selected", selected);
                } else {
                    if ("custom".equals(answer.kind) && answer.text.trim().isEmpty()) continue;
                    value.put("answer", answer.text);
                }
                result.put(value);
            }
            return result;
        }
    }

    static JSONObject liveQuestion(JSONObject card) {
        if (card == null || !"working".equals(card.optString("modelState"))
                || card.optString("requestId", "").isEmpty()) return null;
        JSONObject ask = card.optJSONObject("askUser");
        JSONArray questions = ask == null ? null : ask.optJSONArray("questions");
        return ask == null || ask.optString("id").isEmpty() || questions == null || questions.length() == 0
                ? null : ask;
    }

    private final JSONObject card;
    private final JSONArray questions;
    private final Draft draft;
    private final Reply reply;
    private final AppAppearance colors;
    private boolean pending;
    private AlertDialog dialog;

    HomeQuestionnaire(Context context, JSONObject card, Draft draft, Reply reply, AppAppearance colors) {
        super(context);
        this.card = card;
        this.draft = draft;
        this.reply = reply;
        this.colors = colors;
        questions = card.optJSONObject("askUser").optJSONArray("questions");
        pending = card.optBoolean("questionnairePending");
        setOrientation(VERTICAL);
        setTag("home-questionnaire");
        render();
    }

    private void render() {
        removeAllViews();
        JSONObject question = questions.optJSONObject(draft.page);
        Answer answer = draft.answer(question.optInt("questionIndex"));
        ScrollView scroll = new ScrollView(getContext());
        scroll.setTag("questionnaire-scroll");
        scroll.setVerticalScrollBarEnabled(false);
        scroll.setOverScrollMode(OVER_SCROLL_NEVER);
        LinearLayout body = new LinearLayout(getContext());
        body.setOrientation(VERTICAL);
        LinearLayout titleRow = new LinearLayout(getContext());
        titleRow.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = label(question.optString("question"), 17, colors.ink);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setAccessibilityHeading(true);
        titleRow.addView(title, new LayoutParams(0, -2, 1));
        TextView progress = label((draft.page + 1) + "/" + questions.length(), 12, colors.muted);
        progress.setPadding(dp(8), 0, 0, 0);
        progress.setContentDescription(text("题目 ", "Question ") + (draft.page + 1) + "/" + questions.length());
        titleRow.addView(progress);
        body.addView(titleRow, new LayoutParams(-1, -2));
        JSONArray options = question.optJSONArray("options");
        for (int i = 0; i < options.length(); i += 2) {
            LinearLayout row = new LinearLayout(getContext());
            row.setBaselineAligned(false);
            for (int j = i; j < Math.min(i + 2, options.length()); j++) {
                JSONObject option = options.optJSONObject(j);
                View tile = option(question, option, answer);
                LayoutParams tileParams = new LayoutParams(0, -1, 1);
                if (j > i) tileParams.setMarginStart(dp(6));
                row.addView(tile, tileParams);
            }
            LayoutParams rowParams = new LayoutParams(-1, -2);
            rowParams.topMargin = dp(10);
            body.addView(row, rowParams);
        }
        if ("custom".equals(answer.kind)) {
            TextView custom = label(text("自定义：", "Custom: ") + answer.text, 12, colors.accent);
            custom.setPadding(0, dp(8), 0, 0);
            body.addView(custom);
        }
        String error = draft.error.isEmpty() ? card.optString("questionnaireError") : draft.error;
        if (!error.isEmpty()) {
            TextView notice = label(error, 12, colors.error);
            notice.setAccessibilityLiveRegion(ACCESSIBILITY_LIVE_REGION_POLITE);
            notice.setPadding(0, dp(6), 0, 0);
            body.addView(notice);
        }
        scroll.addView(body);
        addView(scroll, new LayoutParams(-1, 0, 1));

        LinearLayout actions = new LinearLayout(getContext());
        actions.setBaselineAligned(false);
        TextView previous = action("", "arrow-left", text("上一题", "Previous"), () -> {
            draft.page--; render();
        }, false);
        previous.setEnabled(!pending && draft.page > 0);
        previous.setAlpha(draft.page == 0 ? .45f : 1f);
        actions.addView(previous, new LayoutParams(dp(48), dp(48)));
        TextView custom = action(text("自定义", "Custom"), "pencil", text("自定义回答", "Custom answer"),
                () -> editCustom(answer), false);
        custom.setSelected("custom".equals(answer.kind));
        addAction(actions, custom, 1);
        boolean last = draft.page == questions.length() - 1;
        TextView next = action(pending ? text("提交中", "Sending")
                        : last ? text("提交", "Submit") : text("下一题", "Next"),
                last || pending ? null : "arrow-right", last ? text("提交回答", "Submit answers") : text("下一题", "Next"),
                () -> { if (last) send(false); else { draft.page++; render(); } }, true);
        addAction(actions, next, 1.15f);
        TextView cancel = action("", "close", text("取消问答", "Cancel questionnaire"), () -> send(true), false);
        LayoutParams cancelParams = new LayoutParams(dp(48), dp(48));
        cancelParams.setMarginStart(dp(8));
        actions.addView(cancel, cancelParams);
        LayoutParams actionsParams = new LayoutParams(-1, dp(48));
        actionsParams.topMargin = dp(8);
        addView(actions, actionsParams);
    }

    private View option(JSONObject question, JSONObject option, Answer answer) {
        String name = option.optString("label");
        boolean multi = question.optBoolean("multiSelect");
        boolean selected = "option".equals(answer.kind) && name.equals(answer.text)
                || "multi".equals(answer.kind) && answer.selected.contains(name);
        LinearLayout tile = new LinearLayout(getContext());
        tile.setOrientation(VERTICAL);
        tile.setPadding(dp(10), dp(12), dp(10), dp(10));
        tile.setMinimumHeight(dp(66));
        tile.setBackground(surface(selected ? (colors.dark ? 0xff254c59 : 0xffdcf5f8)
                : (colors.dark ? 0x40345463 : 0x70ffffff), selected ? colors.accent : colors.border, 10));
        TextView optionTitle = label(name, 14, colors.ink);
        optionTitle.setTypeface(Typeface.DEFAULT_BOLD);
        ChatIcon marker = new ChatIcon(multi ? (selected ? "checkbox-on" : "checkbox-off")
                : (selected ? "radio-on" : "radio-off"), selected ? colors.accent : colors.muted);
        marker.setBounds(0, 0, dp(18), dp(18));
        optionTitle.setCompoundDrawablesRelative(marker, null, null, null);
        optionTitle.setCompoundDrawablePadding(dp(8));
        tile.addView(optionTitle);
        TextView description = label(option.optString("description"), 11, colors.muted);
        description.setPadding(dp(26), dp(5), 0, 0);
        tile.addView(description);
        tile.setTag("option:" + name);
        tile.setEnabled(!pending);
        tile.setFocusable(true);
        tile.setContentDescription(name + ", " + option.optString("description"));
        tile.setAccessibilityDelegate(new AccessibilityDelegate() {
            @Override public void onInitializeAccessibilityNodeInfo(View host, AccessibilityNodeInfo info) {
                super.onInitializeAccessibilityNodeInfo(host, info);
                info.setClassName(multi ? "android.widget.CheckBox" : "android.widget.RadioButton");
                info.setCheckable(true);
                info.setChecked(selected);
            }
        });
        tile.setOnClickListener(v -> { draft.choose(question, name); render(); });
        if (!multi && !option.optString("preview").isEmpty()) {
            TextView preview = action(text("预览", "Preview"), null, text("预览 ", "Preview ") + name,
                    () -> preview(name, option.optString("preview")), false);
            tile.addView(preview, new LayoutParams(-1, dp(48)));
        }
        return tile;
    }

    private void send(boolean cancelled) {
        if (pending) return;
        pending = true;
        draft.error = "";
        render();
        try {
            reply.send(card.optString("conversationId"), draft.requestId, draft.questionnaireId,
                    cancelled ? new JSONArray() : draft.result(questions), cancelled);
        } catch (Exception exception) {
            pending = false;
            draft.error = exception.getMessage() == null ? exception.getClass().getSimpleName() : exception.getMessage();
            render();
        }
    }

    private void editCustom(Answer answer) {
        if (pending) return;
        if (!"custom".equals(answer.kind)) answer.text = "";
        answer.kind = "custom";
        EditText input = new EditText(getContext());
        input.setText(answer.text);
        input.setHint(text("输入你的回答", "Type your answer"));
        input.setContentDescription(text("自定义回答", "Custom answer"));
        input.setMinLines(3);
        input.setGravity(Gravity.TOP);
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        input.setPadding(dp(20), dp(12), dp(20), dp(12));
        input.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) { answer.text = s.toString(); }
            @Override public void afterTextChanged(Editable s) { }
        });
        dialog = new AlertDialog.Builder(getContext()).setTitle(text("自定义回答", "Custom answer"))
                .setView(input).setPositiveButton(text("完成", "Done"), (d, which) -> { }).create();
        dialog.setOnDismissListener(d -> { dialog = null; render(); });
        dialog.setOnShowListener(d -> {
            input.requestFocus();
            input.setSelection(input.length());
            dialog.getWindow().setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE);
        });
        dialog.show();
    }

    private void preview(String title, String markdown) {
        TextView content = label("", 14, colors.ink);
        content.setTextIsSelectable(true);
        content.setPadding(dp(20), dp(12), dp(20), dp(12));
        ResponseMarkdown.create(getContext(), uri -> {
            try { getContext().startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
            catch (android.content.ActivityNotFoundException ignored) { }
        }).setMarkdown(content, markdown);
        ScrollView scroll = new ScrollView(getContext());
        scroll.addView(content);
        dialog = new AlertDialog.Builder(getContext()).setTitle(title).setView(scroll)
                .setPositiveButton(text("返回问题", "Back"), null).create();
        dialog.setOnDismissListener(d -> dialog = null);
        dialog.show();
    }

    @Override protected void onDetachedFromWindow() {
        if (dialog != null) {
            dialog.setOnDismissListener(null);
            dialog.dismiss();
            dialog = null;
        }
        super.onDetachedFromWindow();
    }

    private void addAction(LinearLayout row, View view, float weight) {
        LayoutParams params = new LayoutParams(0, dp(48), weight);
        params.setMarginStart(dp(8));
        row.addView(view, params);
    }

    private TextView action(String text, String icon, String description, Runnable onClick, boolean primary) {
        int foreground = primary ? (colors.dark ? colors.background : 0xffffffff) : colors.ink;
        TextView button = label(text, 13, foreground);
        button.setGravity(Gravity.CENTER);
        button.setMinHeight(dp(48));
        button.setPadding(dp(text.isEmpty() ? 13 : 8), 0, dp(text.isEmpty() ? 13 : 8), 0);
        button.setBackground(surface(primary ? colors.accent : (colors.dark ? 0xff25404c : 0xffe2edf2), 0, 12));
        button.setContentDescription(description);
        button.setFocusable(true);
        button.setEnabled(!pending);
        button.setOnClickListener(v -> onClick.run());
        button.setAccessibilityDelegate(new AccessibilityDelegate() {
            @Override public void onInitializeAccessibilityNodeInfo(View host, AccessibilityNodeInfo info) {
                super.onInitializeAccessibilityNodeInfo(host, info);
                info.setClassName("android.widget.Button");
            }
        });
        if (icon != null) {
            ChatIcon drawable = new ChatIcon(icon, primary ? foreground : colors.muted);
            drawable.setBounds(0, 0, dp(text.isEmpty() ? 22 : 18), dp(text.isEmpty() ? 22 : 18));
            button.setCompoundDrawablesRelative(primary ? null : drawable, null, primary ? drawable : null, null);
            button.setCompoundDrawablePadding(dp(4));
        }
        return button;
    }

    private android.graphics.drawable.Drawable surface(int color, int border, int radius) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(color);
        shape.setCornerRadius(dp(radius));
        if (border != 0) shape.setStroke(dp(1), border);
        return new RippleDrawable(ColorStateList.valueOf(0x18009db2), shape, null);
    }

    private TextView label(String text, int size, int color) {
        TextView view = new TextView(getContext());
        view.setText(text);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setIncludeFontPadding(false);
        return view;
    }

    private String text(String chinese, String english) {
        return getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh") ? chinese : english;
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
