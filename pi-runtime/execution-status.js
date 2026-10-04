/** Display-only SDK events. No reasoning text, tool arguments, or retry execution lives here. */
export function createExecutionStatus(emit) {
  let phase = "", retryAttempt = 0, terminal = false;
  const publish = (next, details = {}) => {
    if (terminal) return;
    const key = JSON.stringify([next, details]);
    if (key === phase) return;
    phase = key;
    emit({ type: "status", phase: next, ...details });
  };
  return (event) => {
    if (terminal) return;
    const current = phase ? JSON.parse(phase)[0] : "";
    if (event.type === "agent_start" || event.type === "turn_start") publish("thinking");
    else if (event.type === "message_update") {
      const type = event.assistantMessageEvent?.type;
      if (type === "thinking_start" || type === "thinking_delta") publish("thinking");
      else if (type === "text_start" || type === "text_delta") publish("responding");
    } else if (event.type === "tool_execution_start") publish("tool", { toolName: event.toolName });
    else if (event.type === "auto_retry_start") {
      retryAttempt = Number(event.attempt) || 0;
      publish("retrying", { attempt: retryAttempt, maxAttempts: Number(event.maxAttempts) || 0,
        delayMs: Math.max(0, Number(event.delayMs) || 0) });
    } else if (event.type === "auto_retry_end") {
      // A retry's response/tool events may already have replaced the wait label.
      if (current === "retrying" && (Number(event.attempt) || 0) === retryAttempt)
        publish(event.success ? "thinking" : "error");
    } else if (event.type === "auto_compaction_start") {
      publish("compacting");
    } else if (event.type === "auto_compaction_end" && current === "compacting") {
      publish(event.errorMessage && !event.aborted ? "error" : "thinking");
    } else if (event.type === "end") terminal = true;
  };
}
