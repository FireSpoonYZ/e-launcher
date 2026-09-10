package com.example.launcherprobe;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/** Small OpenAI-style tool loop; Android-free so its sequencing can be host tested. */
public final class AgentLoop {
    public interface Provider {
        Reply complete(List<Message> messages, Cancellation cancellation) throws Exception;
    }

    public interface Tool {
        String execute(String arguments) throws Exception;
    }

    public interface Cancellation {
        boolean cancelled();
    }

    public interface Listener {
        void added(Message message);
    }

    public static final class CancelToken implements Cancellation {
        private volatile boolean cancelled;
        public boolean cancelled() { return cancelled; }
        public void cancel() { cancelled = true; }
    }

    public static final class ToolCall {
        public final String id;
        public final String name;
        public final String arguments;

        public ToolCall(String id, String name, String arguments) {
            this.id = id;
            this.name = name;
            this.arguments = arguments;
        }
    }

    public static final class Message {
        public final String role;
        public final String content;
        public final String toolCallId;
        public final List<ToolCall> toolCalls;
        public final boolean incomplete;
        public final String id;

        public Message(String role, String content) {
            this(role, content, null, Collections.emptyList());
        }

        public Message(String role, String content, String toolCallId, List<ToolCall> toolCalls) {
            this(role, content, toolCallId, toolCalls, false);
        }

        public Message(String role, String content, String toolCallId, List<ToolCall> toolCalls,
                boolean incomplete) {
            this(java.util.UUID.randomUUID().toString(), role, content, toolCallId, toolCalls, incomplete);
        }

        public Message(String id, String role, String content, String toolCallId,
                List<ToolCall> toolCalls, boolean incomplete) {
            this.id = id;
            this.role = role;
            this.content = content;
            this.toolCallId = toolCallId;
            this.toolCalls = Collections.unmodifiableList(new ArrayList<>(toolCalls));
            this.incomplete = incomplete;
        }
    }

    public static final class Reply {
        public final String content;
        public final List<ToolCall> toolCalls;

        public Reply(String content, List<ToolCall> toolCalls) {
            this.content = content;
            this.toolCalls = Collections.unmodifiableList(new ArrayList<>(toolCalls));
        }
    }

    private static final int MAX_TOOL_CALLS = 20;
    private static final int MAX_CALLS_PER_REPLY = 10;
    private final int maxRounds;

    public AgentLoop(int maxRounds) {
        if (maxRounds < 1) throw new IllegalArgumentException("maxRounds");
        this.maxRounds = maxRounds;
    }

    public void run(List<Message> history, Provider provider, Map<String, Tool> tools,
            Cancellation cancellation, Listener listener) throws Exception {
        int toolCount = 0;
        for (int round = 0; round < maxRounds; round++) {
            check(cancellation);
            Reply reply = provider.complete(Collections.unmodifiableList(new ArrayList<>(history)), cancellation);
            check(cancellation);
            if (reply.toolCalls.size() > MAX_CALLS_PER_REPLY) {
                throw new IllegalStateException("Model returned too many tool calls");
            }
            Message assistant = new Message("assistant", reply.content, null, reply.toolCalls);
            history.add(assistant);
            listener.added(assistant);
            if (reply.toolCalls.isEmpty()) return;
            if (toolCount + reply.toolCalls.size() > MAX_TOOL_CALLS) {
                appendInterrupted(history, reply.toolCalls, 0, listener, "tool-call limit exceeded");
                throw new IllegalStateException("Agent stopped after " + MAX_TOOL_CALLS + " tool calls");
            }
            toolCount += reply.toolCalls.size();
            for (int index = 0; index < reply.toolCalls.size(); index++) {
                ToolCall call = reply.toolCalls.get(index);
                if (cancellation.cancelled()) {
                    appendInterrupted(history, reply.toolCalls, index, listener, "cancelled before execution");
                    throw new InterruptedException("Cancelled");
                }
                Tool tool = tools.get(call.name);
                String result;
                if (tool == null) {
                    result = error("unknown tool: " + call.name);
                } else {
                    try {
                        result = tool.execute(call.arguments);
                    } catch (Exception exception) {
                        result = cancellation.cancelled() ? error("interrupted; outcome unknown; not retried")
                                : error(exception.getMessage() == null
                                        ? exception.getClass().getSimpleName() : exception.getMessage());
                    }
                }
                Message toolMessage = new Message("tool", result, call.id, Collections.emptyList());
                history.add(toolMessage);
                listener.added(toolMessage);
                if (cancellation.cancelled()) {
                    appendInterrupted(history, reply.toolCalls, index + 1, listener,
                            "cancelled before execution");
                    throw new InterruptedException("Cancelled");
                }
            }
        }
        throw new IllegalStateException("Agent stopped after " + maxRounds + " tool rounds");
    }

    private static void appendInterrupted(List<Message> history, List<ToolCall> calls, int start,
            Listener listener, String reason) {
        for (int index = start; index < calls.size(); index++) {
            Message message = new Message("tool", error(reason), calls.get(index).id,
                    Collections.emptyList());
            history.add(message);
            listener.added(message);
        }
    }

    private static void check(Cancellation cancellation) throws InterruptedException {
        if (cancellation.cancelled()) throw new InterruptedException("Cancelled");
    }

    private static String error(String value) {
        return "{\"ok\":false,\"error\":\"" + value.replace("\\", "\\\\")
                .replace("\"", "\\\"").replace("\n", "\\n") + "\"}";
    }
}
