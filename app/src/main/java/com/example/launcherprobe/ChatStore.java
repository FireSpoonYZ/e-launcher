package com.example.launcherprobe;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** Bounded app-private transcript and provider settings. Backups are disabled in the manifest. */
public final class ChatStore {
    private static final int MAX_MESSAGES = 100;
    private static final int MAX_CONTENT = 50_000;
    private final SharedPreferences preferences;

    public ChatStore(Context context) {
        preferences = context.getSharedPreferences("chat", Context.MODE_PRIVATE);
    }

    public String baseUrl() { return preferences.getString("base_url", "https://api.openai.com/v1"); }
    public String model() { return preferences.getString("model", "gpt-4o-mini"); }
    public String apiKey() { return preferences.getString("api_key", ""); }
    public String reasoningEffort() {
        return ReasoningEffort.normalize(preferences.getString("reasoning_effort", ""));
    }
    public String searchProvider() {
        return SearchConfig.provider(preferences.getString("search_provider", ""));
    }
    public String searchBaseUrl() { return preferences.getString("search_base_url", ""); }

    public void settings(String baseUrl, String model, String apiKey, String reasoningEffort,
            String searchProvider, String searchBaseUrl) {
        preferences.edit().putString("base_url", baseUrl.trim()).putString("model", model.trim())
                .putString("api_key", apiKey.trim())
                .putString("reasoning_effort", ReasoningEffort.normalize(reasoningEffort))
                .putString("search_provider", SearchConfig.provider(searchProvider))
                .putString("search_base_url", searchBaseUrl.trim()).apply();
    }

    public List<AgentLoop.Message> load() {
        List<AgentLoop.Message> messages = new ArrayList<>();
        try {
            JSONArray values = new JSONArray(preferences.getString("history", "[]"));
            for (int index = 0; index < values.length(); index++) {
                JSONObject value = values.getJSONObject(index);
                List<AgentLoop.ToolCall> calls = new ArrayList<>();
                JSONArray storedCalls = value.optJSONArray("tool_calls");
                if (storedCalls != null) for (int callIndex = 0; callIndex < storedCalls.length(); callIndex++) {
                    JSONObject call = storedCalls.getJSONObject(callIndex);
                    calls.add(new AgentLoop.ToolCall(call.getString("id"), call.getString("name"),
                            call.optString("arguments", "{}")));
                }
                messages.add(new AgentLoop.Message(value.getString("role"),
                        value.isNull("content") ? null : value.optString("content", ""),
                        value.optString("tool_call_id", null), calls));
            }
            return AgentHistory.trimCompleteTurns(messages, MAX_MESSAGES);
        } catch (Exception ignored) {
            preferences.edit().remove("history").apply();
            return new ArrayList<>();
        }
    }

    public void save(List<AgentLoop.Message> messages) {
        try {
            JSONArray values = new JSONArray();
            for (AgentLoop.Message message : AgentHistory.trimCompleteTurns(messages, MAX_MESSAGES)) {
                put(values, message);
            }
            preferences.edit().putString("history", values.toString()).apply();
        } catch (Exception exception) {
            throw new IllegalStateException("无法保存聊天记录", exception);
        }
    }

    private static void put(JSONArray values, AgentLoop.Message message) throws Exception {
        JSONObject value = new JSONObject().put("role", message.role)
                .put("content", message.content == null
                        ? JSONObject.NULL : truncate(message.content));
        if (message.toolCallId != null) value.put("tool_call_id", message.toolCallId);
        if (!message.toolCalls.isEmpty()) {
            JSONArray calls = new JSONArray();
            for (AgentLoop.ToolCall call : message.toolCalls) calls.put(new JSONObject()
                    .put("id", call.id).put("name", call.name)
                    .put("arguments", truncate(call.arguments)));
            value.put("tool_calls", calls);
        }
        values.put(value);
    }

    public void clear() {
        preferences.edit().remove("history").apply();
    }

    private static String truncate(String value) {
        return value.length() <= MAX_CONTENT ? value : value.substring(0, MAX_CONTENT);
    }
}
