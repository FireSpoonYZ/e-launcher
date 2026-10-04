package com.example.launcherprobe;

import org.json.JSONObject;
import java.util.LinkedHashMap;
import java.util.HashSet;
import java.util.Set;

/** Display-only state. Request ownership remains with ChatCoordinator; never executes or retries tools. */
final class TaskExecutionState {
    private String phase = "starting";
    private String tool = "";
    private int attempt, maxAttempts;
    private long delayMs;
    private boolean stopped, terminal, question;
    private final LinkedHashMap<String, String> tools = new LinkedHashMap<>();
    private final Set<String> showerWaits = new HashSet<>();

    void accept(JSONObject event) {
        if (terminal || stopped) return;
        switch (event.optString("type")) {
            case "status":
                String next = event.optString("phase");
                if (Set.of("starting", "thinking", "responding", "tool", "retrying", "compacting", "error").contains(next)) {
                    phase = next;
                    if ("tool".equals(next)) tool = shortName(event.optString("toolName"));
                    attempt = event.optInt("attempt");
                    maxAttempts = event.optInt("maxAttempts");
                    delayMs = Math.max(0, event.optLong("delayMs"));
                }
                break;
            case "text_delta": phase = "responding"; break;
            case "tool_start":
                tool = shortName(event.optString("name"));
                tools.put(event.optString("toolCallId"), tool); phase = "tool"; break;
            case "tool_end":
                if (tools.remove(event.optString("toolCallId")) != null) {
                    tool = tools.isEmpty() ? "" : tools.values().iterator().next();
                    phase = tools.isEmpty() ? "thinking" : "tool";
                }
                break;
            case "extension_ui":
                JSONObject state = event.optJSONObject("state");
                question = state != null && state.optJSONObject("askUser") != null;
                break;
            case "shower_wait":
                String call = event.optString("callId");
                if (event.optBoolean("waiting")) showerWaits.add(call); else showerWaits.remove(call);
                break;
            default: break;
        }
    }

    void stop() { if (!terminal) { stopped = true; phase = "stopping"; } }
    void finish(String status) {
        terminal = true; phase = status; question = false; showerWaits.clear();
    }
    JSONObject snapshot() {
        String visible = stopped && !terminal ? "stopping" : question ? "waiting_user"
                : !showerWaits.isEmpty() ? "waiting_shower" : phase;
        try { return new JSONObject().put("phase", visible).put("toolName", tool)
                .put("attempt", attempt).put("maxAttempts", maxAttempts).put("delayMs", delayMs)
                .put("message", label(visible, tool, attempt, maxAttempts, delayMs)); }
        catch (org.json.JSONException e) { throw new IllegalStateException(e); }
    }
    static String label(String phase, String tool, int attempt, int maxAttempts, long delayMs) {
        return switch (phase) {
            case "thinking" -> "正在思考…";
            case "responding" -> "正在回复…";
            case "tool" -> tool.isEmpty() ? "正在使用工具…" : "正在使用 " + tool;
            case "retrying" -> "等待重试" + (attempt > 0 ? " " + attempt + (maxAttempts > 0 ? "/" + maxAttempts : "") : "")
                    + (delayMs > 0 ? " · " + ((delayMs + 999) / 1000) + " 秒后" : "");
            case "compacting" -> "正在整理上下文…";
            case "waiting_user" -> "等待回答";
            case "waiting_shower" -> "等待结束 Shower 手动接管";
            case "stopping" -> "正在停止…";
            case "interrupted" -> "运行已中断";
            case "error" -> "执行失败";
            case "aborted" -> "已停止";
            case "truncated" -> "回复未完成";
            case "completed" -> "本轮已结束";
            default -> "正在启动…";
        };
    }
    private static String shortName(String value) { return TaskCardModel.shortText(value, 60); }
}
