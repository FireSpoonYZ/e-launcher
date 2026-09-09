package com.example.launcherprobe;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/** Non-streaming OpenAI Chat Completions adapter. */
public final class OpenAiProvider implements AgentLoop.Provider {
    private static final int MAX_RESPONSE = 1024 * 1024;
    private final String endpoint;
    private final String apiKey;
    private final String model;
    private final String reasoningEffort;
    private final JSONArray tools;
    private volatile HttpURLConnection active;

    public OpenAiProvider(String baseUrl, String apiKey, String model, String reasoningEffort,
            JSONArray tools) {
        this.endpoint = ProviderConfig.validateBaseUrl(baseUrl) + "/chat/completions";
        this.apiKey = apiKey;
        this.model = model;
        this.reasoningEffort = ReasoningEffort.normalize(reasoningEffort);
        this.tools = tools;
    }

    public void cancel() {
        HttpURLConnection connection = active;
        if (connection != null) connection.disconnect();
    }

    @Override
    public AgentLoop.Reply complete(List<AgentLoop.Message> messages,
            AgentLoop.Cancellation cancellation) throws Exception {
        if (apiKey.trim().isEmpty() || model.trim().isEmpty()) {
            throw new IllegalStateException("请先在设置中填写 API Key 和模型。");
        }
        JSONObject request = new JSONObject(ReasoningEffort.requestFields(model, reasoningEffort))
                .put("stream", false).put("tools", tools).put("messages", messages(messages));
        HttpURLConnection connection = (HttpURLConnection) new URL(endpoint).openConnection();
        active = connection;
        try {
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(60_000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("Authorization", "Bearer " + apiKey);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            byte[] body = request.toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            connection.getOutputStream().write(body);
            if (cancellation.cancelled()) throw new InterruptedException("Cancelled");
            int status = connection.getResponseCode();
            String response = read(status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream());
            if (status < 200 || status >= 300) {
                throw new IllegalStateException("模型服务 HTTP " + status + ": " + briefError(response));
            }
            JSONObject message = new JSONObject(response).getJSONArray("choices")
                    .getJSONObject(0).getJSONObject("message");
            List<AgentLoop.ToolCall> calls = new ArrayList<>();
            JSONArray values = message.optJSONArray("tool_calls");
            if (values != null) for (int index = 0; index < values.length(); index++) {
                JSONObject call = values.getJSONObject(index);
                JSONObject function = call.getJSONObject("function");
                calls.add(new AgentLoop.ToolCall(call.getString("id"),
                        function.getString("name"), function.optString("arguments", "{}")));
            }
            return new AgentLoop.Reply(message.isNull("content") ? null
                    : message.optString("content", ""), calls);
        } finally {
            active = null;
            connection.disconnect();
        }
    }

    private static JSONArray messages(List<AgentLoop.Message> messages) throws JSONException {
        JSONArray array = new JSONArray();
        for (AgentLoop.Message value : messages) {
            JSONObject message = new JSONObject().put("role", value.role);
            if (value.content == null) message.put("content", JSONObject.NULL);
            else message.put("content", value.content);
            if (value.toolCallId != null) message.put("tool_call_id", value.toolCallId);
            if (!value.toolCalls.isEmpty()) {
                JSONArray calls = new JSONArray();
                for (AgentLoop.ToolCall call : value.toolCalls) {
                    calls.put(new JSONObject().put("id", call.id).put("type", "function")
                            .put("function", new JSONObject().put("name", call.name)
                                    .put("arguments", call.arguments)));
                }
                message.put("tool_calls", calls);
            }
            array.put(message);
        }
        return array;
    }

    private static String read(InputStream stream) throws Exception {
        if (stream == null) return "";
        StringBuilder value = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            char[] buffer = new char[4096];
            int count;
            while ((count = reader.read(buffer)) != -1) {
                if (value.length() + count > MAX_RESPONSE) throw new IllegalStateException("模型响应过大");
                value.append(buffer, 0, count);
            }
        }
        return value.toString();
    }

    private static String briefError(String response) {
        try {
            String message = new JSONObject(response).optJSONObject("error").optString("message");
            return message.substring(0, Math.min(300, message.length()));
        } catch (RuntimeException | JSONException ignored) {
            return "请求失败";
        }
    }
}
