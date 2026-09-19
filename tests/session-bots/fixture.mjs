import { emptyState, applyHost, applyTool } from "../../pi-runtime/session-bots/core.mjs";
export const schedule = { kind: "daily", timeZone: "Europe/Amsterdam", hour: 8, minute: 0 };
export const aRoutine = () => ({ title: "日报", prompt: "汇总最新项目进展", schedule: structuredClone(schedule) });
export class Fixture {
  state = emptyState(); clock = 1800000000000; sequence = 0;
  id = () => `id-${String(++this.sequence).padStart(5, "0")}`;
  opts = () => ({ now: this.clock++, id: this.id });
  constructor() {
    for (const [id, name] of [["A", "管家"], ["B", "研究员"], ["C", "审稿员"]]) this.host({ type: "importSession", id, name,
      rolePrompt: `你是${name}`, selection: { provider: "test", model: "test-model", thinkingLevel: "high" } });
  }
  host(command) { const out = applyHost(this.state, command, this.opts()); this.state = out.state; return out.result; }
  tool(run, name, args = {}, callId = this.id()) {
    const out = applyTool(this.state, { runId: run.id, token: run.token }, { name, args, callId }, this.opts());
    this.state = out.state; return out.result;
  }
  user(id = "A", body = "开始", submissionId = this.id()) {
    return this.host({ type: "userMessage", toSessionId: id, body, submissionId });
  }
  claim(id = "A", processId = "p1") { return this.host({ type: "claimNext", sessionId: id, processId }); }
  start(id = "A", body = "开始") { this.user(id, body); return this.claim(id).run; }
  finish(run, status = "completed") { return this.host({ type: "completeRun", runId: run.id, token: run.token, status }); }
}
export function code(expected) { return e => e.code === expected; }
