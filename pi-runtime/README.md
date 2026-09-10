# pi-runtime Android text agent

A reusable, text-only boundary around `@earendil-works/pi-agent-core` and the `pi-ai` OpenAI-compatible chat-completions adapter.

```js
import { createPiRuntime } from "./index.js";

const runtime = createPiRuntime({
  baseUrl: "https://your-openai-compatible-host.example/v1",
  apiKey: "explicit-host-supplied-key",
  modelId: "your-model-id",
  history: [{ role: "user", content: "Earlier message" }],
});

runtime.subscribe((event) => bridgeSend(JSON.stringify(event)));
await runtime.prompt("Hello");
runtime.abort();
```

Events are `{type:"text_delta",delta}`, `{type:"message",message:{role,content}}`, `{type:"error",message,aborted}`, then `{type:"end",status}`. `replaceHistory()` accepts only Java chat history entries with `role: "user" | "assistant"` and string `content`; non-empty `tool_calls` are rejected because tools are not connected in this phase.

The caller must supply `baseUrl`, `apiKey`, and `modelId`. The direct OpenAI adapter is used without `max_tokens` or `max_completion_tokens`; the app does not impose an output token budget or claim known limits for a custom model. Reply display, copy/share and stored message content are not character-truncated. Existing history-count and tool-argument policies are separate from reply length. This module does not load personal pi configuration, credentials, extensions, or coding-agent. Run `npm test` for deterministic in-memory Agent event/abort checks plus a loopback mock SSE check through the real pi-ai OpenAI adapter. The mock key and response are not a real provider validation.

Android uses `scripts/prepare-pi-runtime.ps1` to verify Node Mobile 24.18.0-0, extract only the arm64 library/headers, run `npm ci`, and bundle `android.js` into the APK. The app starts Node once with private `HOME`/`TMPDIR`, exchanges request-ID-tagged newline JSON over a randomized abstract Unix socket whose connecting peer must match the app process UID and PID, and exposes this as the explicitly labelled “pi 文本模式”; the existing tool mode remains available. Pi mode registers no tools and rejects tool-bearing history with a visible instruction instead of dropping it. Startup failure is sticky until process restart; EOF ends an active request with an error. Cancellation is recorded before startup and requests cannot overwrite a still-active listener.

Interrupted replies are retained: abort/error/length-limit events keep generated text, and Android persists it with an `incomplete` flag and a visible unfinished label. Completed replies remain unmarked. Android also checkpoints the visible preview at pause/destroy boundaries, not on every token; abrupt process termination without lifecycle callbacks is not covered.

`npm test` also builds and executes the shipped CJS socket entry against mock SSE, checking request IDs, explicit busy rejection, abort and subsequent completion. Device/UI checks remain separate. After JS changes, run `npm --prefix pi-runtime test` (which rebuilds the bundle) before `scripts/verify.ps1` and installing the APK. Native inputs can be reproduced using `scripts/prepare-pi-runtime.ps1`.
