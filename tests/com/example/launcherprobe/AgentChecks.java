package com.example.launcherprobe;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.net.InetAddress;
import java.net.URI;

/** Runnable without Android or a test framework: java -ea ...AgentChecks. */
public final class AgentChecks {
    private static AgentLoop.ToolCall call(String id, String name) {
        return new AgentLoop.ToolCall(id, name, "{}");
    }

    private static void multipleRounds() throws Exception {
        List<AgentLoop.Message> history = new ArrayList<>();
        history.add(new AgentLoop.Message("user", "go"));
        int[] providers = {0};
        AgentLoop.Provider provider = (messages, cancellation) -> {
            providers[0]++;
            if (providers[0] == 1) return new AgentLoop.Reply(null,
                    java.util.Collections.singletonList(call("one", "echo")));
            assert messages.get(messages.size() - 1).toolCallId.equals("one");
            return new AgentLoop.Reply("done", java.util.Collections.emptyList());
        };
        Map<String, AgentLoop.Tool> tools = new HashMap<>();
        tools.put("echo", arguments -> "result");
        new AgentLoop(3).run(history, provider, tools, () -> false, ignored -> { });
        assert providers[0] == 2;
        assert history.size() == 4;
        assert history.get(2).role.equals("tool") && history.get(2).content.equals("result");
        assert history.get(3).content.equals("done");
    }

    private static void failuresAndLimits() throws Exception {
        List<AgentLoop.Message> unknown = new ArrayList<>();
        AgentLoop.Provider oneUnknown = (messages, cancellation) -> messages.isEmpty()
                ? new AgentLoop.Reply(null, java.util.Collections.singletonList(call("x", "missing")))
                : new AgentLoop.Reply("done", java.util.Collections.emptyList());
        new AgentLoop(2).run(unknown, oneUnknown, new HashMap<>(), () -> false, ignored -> { });
        assert unknown.get(1).content.contains("unknown tool: missing") : unknown.get(1).content;

        List<AgentLoop.Message> limited = new ArrayList<>();
        boolean capped = false;
        try {
            new AgentLoop(2).run(limited, (messages, cancellation) ->
                    new AgentLoop.Reply(null, java.util.Collections.singletonList(call("x", "ok"))),
                    java.util.Collections.singletonMap("ok", arguments -> "ok"), () -> false,
                    ignored -> { });
        } catch (IllegalStateException expected) {
            capped = expected.getMessage().contains("2");
        }
        assert capped && limited.size() == 4;
    }

    private static void cancellation() throws Exception {
        AgentLoop.CancelToken token = new AgentLoop.CancelToken();
        List<AgentLoop.Message> history = new ArrayList<>();
        int[] providerCalls = {0};
        AgentLoop.Provider provider = (messages, cancellation) -> {
            providerCalls[0]++;
            if (providerCalls[0] == 1) return new AgentLoop.Reply(null, java.util.Arrays.asList(
                    call("first", "stop"), call("second", "never")));
            assert messages.get(messages.size() - 1).role.equals("user");
            return new AgentLoop.Reply("recovered", java.util.Collections.emptyList());
        };
        Map<String, AgentLoop.Tool> tools = new HashMap<>();
        tools.put("stop", arguments -> {
            token.cancel();
            throw new java.io.IOException("disconnected");
        });
        tools.put("never", arguments -> { throw new AssertionError("side effect rerun"); });
        try { new AgentLoop(2).run(history, provider, tools, token, ignored -> { }); }
        catch (InterruptedException expected) { }
        assert history.size() == 3;
        assert history.get(1).toolCallId.equals("first")
                && history.get(1).content.contains("outcome unknown");
        assert history.get(2).toolCallId.equals("second")
                && history.get(2).content.contains("before execution");
        history.add(new AgentLoop.Message("user", "next"));
        new AgentLoop(2).run(history, provider, tools, () -> false, ignored -> { });
        assert history.get(history.size() - 1).content.equals("recovered");
    }

    private static void oversizedTurnDrops() throws Exception {
        List<AgentLoop.Message> history = new ArrayList<>();
        history.add(new AgentLoop.Message("system", "rules"));
        history.add(new AgentLoop.Message("user", "large"));
        int[] round = {0};
        try {
            new AgentLoop(20).run(history, (messages, cancellation) -> {
                round[0]++;
                List<AgentLoop.ToolCall> calls = new ArrayList<>();
                int count = round[0] == 20 ? 10 : 1;
                for (int index = 0; index < count; index++) {
                    calls.add(call(round[0] + "-" + index, "ok"));
                }
                return new AgentLoop.Reply(null, calls);
            }, java.util.Collections.singletonMap("ok", arguments -> "ok"), () -> false,
                    ignored -> { });
        } catch (IllegalStateException expected) {
            assert expected.getMessage().contains("20 tool calls");
        }
        assert history.size() == 51 : history.size();
        List<AgentLoop.Message> next = AgentHistory.trimCompleteTurns(history, 49);
        assert next.size() == 1 && next.get(0).role.equals("system");
        next.add(new AgentLoop.Message("user", "next"));
        assert next.size() == 2;
    }

    private static void retentionBoundary() {
        List<AgentLoop.Message> history = new ArrayList<>();
        history.add(new AgentLoop.Message("system", "rules"));
        history.add(new AgentLoop.Message("user", "old"));
        history.add(new AgentLoop.Message("assistant", null, null,
                java.util.Arrays.asList(call("a", "x"), call("b", "x"))));
        history.add(new AgentLoop.Message("tool", "a", "a", java.util.Collections.emptyList()));
        history.add(new AgentLoop.Message("tool", "b", "b", java.util.Collections.emptyList()));
        history.add(new AgentLoop.Message("assistant", "old done"));
        history.add(new AgentLoop.Message("user", "new"));
        history.add(new AgentLoop.Message("assistant", "new done"));
        List<AgentLoop.Message> trimmed = AgentHistory.trimCompleteTurns(history, 4);
        assert trimmed.size() == 3;
        assert trimmed.get(0).role.equals("system") && trimmed.get(1).content.equals("new");
        List<AgentLoop.Message> interrupted = new ArrayList<>();
        interrupted.add(history.get(2));
        interrupted.add(history.get(3));
        assert AgentHistory.repair(interrupted).size() == 3;
    }

    private static void webAddressPolicy() throws Exception {
        boolean blocked = false;
        try { WebAddressPolicy.validatePublic(new URI("http://example.com/private")); }
        catch (IllegalArgumentException expected) { blocked = true; }
        assert blocked;
        blocked = false;
        try { WebAddressPolicy.validatePublic(new URI("file:///etc/passwd")); }
        catch (IllegalArgumentException expected) { blocked = true; }
        assert blocked;
        blocked = false;
        try { WebAddressPolicy.validated(java.util.Arrays.asList(
                InetAddress.getByName("93.184.216.34"), InetAddress.getByName("100.64.0.1"))); }
        catch (IllegalArgumentException expected) { blocked = true; }
        assert blocked;
    }

    private static void observationAndActionFences() {
        ObservationRegistry<String> observed = new ObservationRegistry<>(2);
        assert observed.add("0", "window1-node1", false);
        assert observed.add("0.0", "window1-password-child", true);
        assert !observed.add("0.1", "excluded", false);
        observed.require("0", "window1-node1", false, String::equals);
        boolean rejected = false;
        try { observed.require("0.1", "excluded", false, String::equals); }
        catch (IllegalArgumentException expected) { rejected = true; }
        assert rejected;
        rejected = false;
        try { observed.require("0.0", "window1-password-child", true, String::equals); }
        catch (IllegalArgumentException expected) { rejected = true; }
        assert rejected;
        rejected = false;
        try { observed.require("0", "window1-node2", false, String::equals); }
        catch (IllegalStateException expected) { rejected = true; }
        assert rejected;

        AgentLoop.CancelToken token = new AgentLoop.CancelToken();
        ActionFence timeout = new ActionFence(token, () -> true);
        timeout.expire();
        assert !timeout.tryStart();
        ActionFence cancelled = new ActionFence(token, () -> true);
        token.cancel();
        assert !cancelled.tryStart();
        assert !new ActionFence(() -> false, () -> false).tryStart();
    }

    private static void lifecycleFenceAndConfig() throws Exception {
        RunEpoch epoch = new RunEpoch();
        long old = epoch.acquire();
        String[] stored = {"old"};
        epoch.retire(old);
        long replacement = epoch.acquire();
        stored[0] = "new";
        assert !epoch.runIfOwned(old, () -> stored[0] = "stale");
        assert epoch.runIfOwned(replacement, () -> stored[0] = "replacement");
        assert stored[0].equals("replacement");

        assert ProviderConfig.validateBaseUrl(" https://example.com/v1/ ")
                .equals("https://example.com/v1");
        for (String invalid : new String[]{"https://", "https://bad host", "http://example.com",
                "https://user@example.com/v1", "https://example.com/v1?q=x",
                "https://example.com:99999/v1"}) {
            boolean rejected = false;
            try { ProviderConfig.validateBaseUrl(invalid); }
            catch (IllegalArgumentException expected) { rejected = true; }
            assert rejected : invalid;
        }
        assert ExactText.validate(" hello ", 20).equals(" hello ");
        assert ExactText.validate("", 20).isEmpty();
        assert !ReasoningEffort.requestFields("model", ReasoningEffort.DEFAULT)
                .containsKey("reasoning_effort");
        assert ReasoningEffort.requestFields("model", ReasoningEffort.LOW)
                .get("reasoning_effort").equals("low");
        assert ReasoningEffort.requestFields("model", ReasoningEffort.MEDIUM)
                .get("reasoning_effort").equals("medium");
        assert ReasoningEffort.requestFields("model", ReasoningEffort.HIGH)
                .get("reasoning_effort").equals("high");
        assert ReasoningEffort.normalize("unsupported").isEmpty();
        assert SearchConfig.provider("unknown").equals(SearchConfig.DUCKDUCKGO);
        assert SearchConfig.validateBaseUrl("https://search.example:3000/")
                .equals("https://search.example:3000");
        assert SearchConfig.sameOrigin(new URI("https://search.example:3000"),
                new URI("https://search.example:3000/search?q=x"));
        assert !SearchConfig.sameOrigin(new URI("https://search.example:3000"),
                new URI("https://other.example:3000/search"));
        boolean badSearch = false;
        try { SearchConfig.validateBaseUrl("http://192.168.50.203:3006"); }
        catch (IllegalArgumentException expected) { badSearch = true; }
        assert badSearch;
    }

    private static void searchParsing() {
        String html = "<a rel='nofollow' href='//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x' class='result-link'>Example &amp; One</a>"
                + "<td class='result-snippet'>Useful <b>snippet</b>.</td>";
        List<SearchParser.Result> results = SearchParser.parse(html);
        assert results.size() == 1;
        assert results.get(0).url.equals("https://example.com/a");
        assert results.get(0).title.equals("Example & One");
        assert SearchParser.parse(html.replace("Useful", "CAPTCHA documentation")).size() == 1;
        boolean bot = false;
        try { SearchParser.parse("<div class='anomaly-modal'>captcha</div>"); }
        catch (IllegalStateException expected) { bot = true; }
        assert bot;
    }

    public static void main(String[] args) throws Exception {
        multipleRounds();
        failuresAndLimits();
        cancellation();
        oversizedTurnDrops();
        retentionBoundary();
        webAddressPolicy();
        observationAndActionFences();
        lifecycleFenceAndConfig();
        searchParsing();
        System.out.println("PASS: agent recovery/retention, action/lifecycle fences, config/text, search and URL policy");
    }
}
