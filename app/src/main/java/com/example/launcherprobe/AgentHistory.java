package com.example.launcherprobe;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Repairs interrupted tool exchanges and retains whole user turns. */
public final class AgentHistory {
    private AgentHistory() { }

    public static List<AgentLoop.Message> repair(List<AgentLoop.Message> source) {
        List<AgentLoop.Message> result = new ArrayList<>();
        for (int index = 0; index < source.size(); index++) {
            AgentLoop.Message message = source.get(index);
            result.add(message);
            if (!"assistant".equals(message.role) || message.toolCalls.isEmpty()) continue;
            Set<String> answered = new HashSet<>();
            int next = index + 1;
            while (next < source.size() && "tool".equals(source.get(next).role)) {
                answered.add(source.get(next).toolCallId);
                result.add(source.get(next));
                next++;
            }
            for (AgentLoop.ToolCall call : message.toolCalls) if (!answered.contains(call.id)) {
                result.add(new AgentLoop.Message("tool",
                        "{\"ok\":false,\"error\":\"interrupted; outcome unknown; not retried\"}",
                        call.id, java.util.Collections.emptyList()));
            }
            index = next - 1;
        }
        return result;
    }

    public static List<AgentLoop.Message> trimCompleteTurns(List<AgentLoop.Message> source, int max) {
        if (max < 1) throw new IllegalArgumentException("max");
        List<AgentLoop.Message> repaired = repair(source);
        if (repaired.size() <= max) return repaired;
        int system = !repaired.isEmpty() && "system".equals(repaired.get(0).role) ? 1 : 0;
        int allowance = max - system;
        int start = repaired.size();
        for (int index = repaired.size() - 1; index >= system; index--) {
            if ("user".equals(repaired.get(index).role)
                    && repaired.size() - index <= allowance) start = index;
        }
        List<AgentLoop.Message> result = new ArrayList<>();
        if (system == 1) result.add(repaired.get(0));
        // A completed old turn that cannot fit is safer to forget than to split or crash Send.
        if (start < repaired.size()) result.addAll(repaired.subList(start, repaired.size()));
        return result;
    }
}
