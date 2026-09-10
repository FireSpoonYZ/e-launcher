package com.example.launcherprobe;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

public final class ConversationTreeChecks {
    public static void main(String[] args) {
        ConversationTree tree = new ConversationTree(Collections.emptyList(), null);
        AgentLoop.Message user = new AgentLoop.Message("user", "same question");
        AgentLoop.Message shared = new AgentLoop.Message("assistant", "shared answer");
        AgentLoop.Message python = new AgentLoop.Message("user", "Python");
        AgentLoop.Message answer = new AgentLoop.Message("assistant", "code");
        tree.merge(Arrays.asList(user, shared, python, answer));
        for (ConversationTree.Row row : tree.rows(Collections.emptySet())) assert row.depth == 0;
        tree.select(shared.id);
        AgentLoop.Message javaBranch = new AgentLoop.Message("user", "Java");
        tree.merge(Arrays.asList(user, shared, javaBranch));
        assert tree.nodes().size() == 5;
        assert tree.node(python.id).parentId.equals(shared.id);
        assert tree.node(javaBranch.id).parentId.equals(shared.id);
        List<ConversationTree.Row> rows = tree.rows(Collections.emptySet());
        assert rows.get(0).depth == 0 && rows.get(1).depth == 0;
        assert rows.get(2).node.id.equals(javaBranch.id); // Current continuation first.
        assert rows.get(2).depth == 1 && rows.get(3).depth == 1; // Alternative user inputs align.
        assert rows.get(4).depth == 2; // The chosen alternative's body steps in once.
        assert tree.rows(Collections.singleton(shared.id)).size() == 2;
        assert tree.rows(Collections.singleton(user.id)).size() == 1;
        assert tree.rows(Collections.singleton(python.id)).size() == 4;
        assert tree.rows(Collections.emptySet()).get(0).descendants == 4;
        tree.select(answer.id);
        assert tree.path().get(2).id.equals(python.id);
        AgentLoop.Message next = new AgentLoop.Message("user", "next");
        // Saving provider context with a trimmed prefix must not disconnect old ancestors.
        tree.merge(Arrays.asList(python, answer, next));
        assert tree.path().size() == 5 && tree.path().get(0).id.equals(user.id);
        assert tree.nodes().size() == 6;
        java.util.Map<String, Integer> branchDepths = new java.util.HashMap<>();
        for (ConversationTree.Row row : tree.rows(Collections.emptySet())) branchDepths.put(row.node.id, row.depth);
        assert branchDepths.get(python.id) == 1 && branchDepths.get(javaBranch.id) == 1;
        assert branchDepths.get(answer.id) == 2 && branchDepths.get(next.id) == 2;
        // A subsequent fork adds peer inputs, then each body steps in once more.
        ConversationTree nested = new ConversationTree(tree.nodes(), answer.id);
        AgentLoop.Message alternate = new AgentLoop.Message("user", "alternative follow-up");
        AgentLoop.Message nestedAnswer = new AgentLoop.Message("assistant", "nested answer");
        AgentLoop.Message nestedFollow = new AgentLoop.Message("user", "ordinary follow-up");
        nested.merge(Arrays.asList(user, shared, python, answer, alternate, nestedAnswer, nestedFollow));
        java.util.Map<String, Integer> nestedDepths = new java.util.HashMap<>();
        for (ConversationTree.Row row : nested.rows(Collections.emptySet())) nestedDepths.put(row.node.id, row.depth);
        assert nestedDepths.get(next.id) == 3 && nestedDepths.get(alternate.id) == 3;
        assert nestedDepths.get(nestedAnswer.id) == 4 && nestedDepths.get(nestedFollow.id) == 4;
        String streamId = java.util.UUID.randomUUID().toString();
        AgentLoop.Message partial = new AgentLoop.Message(streamId, "assistant", "part", null, Collections.emptyList(), true);
        tree.merge(Arrays.asList(next, partial));
        AgentLoop.Message finished = new AgentLoop.Message(streamId, "assistant", "part complete", null, Collections.emptyList(), false);
        tree.merge(Arrays.asList(next, finished));
        assert tree.nodes().size() == 7 && !tree.node(streamId).message.incomplete;
        assert tree.node(streamId).message.content.equals("part complete");
        ConversationTree restored = new ConversationTree(tree.nodes(), tree.leaf());
        assert restored.path().size() == 6 && restored.nodes().size() == 7;
        restored.select(tree.node(user.id).parentId); // Editing root user starts another root.
        AgentLoop.Message repeated = new AgentLoop.Message("user", "same question");
        restored.merge(Collections.singletonList(repeated));
        assert !repeated.id.equals(user.id) && restored.nodes().size() == 8;
        assert restored.path().size() == 1;
        ConversationTree toolTree = new ConversationTree(Collections.emptyList(), null);
        AgentLoop.Message call = new AgentLoop.Message("assistant", null, null,
                Collections.singletonList(new AgentLoop.ToolCall("call", "tool", "{}")));
        toolTree.merge(Arrays.asList(user, call));
        toolTree.select(call.id);
        List<AgentLoop.Message> repaired = new java.util.ArrayList<>(AgentHistory.repair(toolTree.path()));
        AgentLoop.Message syntheticTool = repaired.get(repaired.size() - 1);
        AgentLoop.Message afterTool = new AgentLoop.Message("user", "continue here");
        repaired.add(afterTool);
        toolTree.merge(repaired);
        toolTree.merge(AgentHistory.trimCompleteTurns(repaired, 50));
        assert toolTree.node(afterTool.id).parentId.equals(syntheticTool.id);
        assert "tool".equals(syntheticTool.role);
        int count = toolTree.nodes().size();
        toolTree.merge(AgentHistory.repair(toolTree.path()));
        assert toolTree.nodes().size() == count && toolTree.path().size() == 4;
        for (boolean system : new boolean[]{false, true}) {
            ConversationTree longTree = new ConversationTree(Collections.emptyList(), null);
            List<AgentLoop.Message> longPath = new java.util.ArrayList<>();
            if (system) longPath.add(new AgentLoop.Message("system", "system"));
            longPath.add(new AgentLoop.Message("user", "long tool turn"));
            for (int i = 0; i < 49; i++) longPath.add(new AgentLoop.Message("assistant", "step " + i));
            longTree.merge(longPath);
            String previousLeaf = longTree.leaf();
            AgentLoop.Message continuation = new AgentLoop.Message("user", "continue after oversized turn");
            longPath.add(continuation);
            longTree.merge(longPath); // Persist first, exactly as the send path does.
            List<AgentLoop.Message> context = AgentHistory.trimCompleteTurns(longPath, 50);
            assert context.size() == (system ? 2 : 1);
            longTree.merge(context);
            assert longTree.node(continuation.id).parentId.equals(previousLeaf);
            assert longTree.path().size() == longPath.size();
        }
        System.out.println("PASS: tree branches, flat chains, subtree folding, oversized turns, stable partial identity and restore");
    }
}
