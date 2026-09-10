package com.example.launcherprobe;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Persistent message identities; indentation counts forks rather than turns. */
public final class ConversationTree {
    public static final class Node {
        public final String id, parentId;
        public final AgentLoop.Message message;
        public Node(String parentId, AgentLoop.Message message) {
            this.id = message.id;
            this.parentId = parentId;
            this.message = message;
        }
    }

    public static final class Row {
        public final Node node;
        public final int depth, descendants;
        public final boolean currentPath;
        Row(Node node, int depth, int descendants, boolean currentPath) {
            this.node = node;
            this.depth = depth;
            this.descendants = descendants;
            this.currentPath = currentPath;
        }
    }

    private final LinkedHashMap<String, Node> nodes = new LinkedHashMap<>();
    private String leaf;

    public ConversationTree(List<Node> stored, String leaf) {
        for (Node node : stored) {
            if (nodes.containsKey(node.id) || (node.parentId != null && !nodes.containsKey(node.parentId)))
                throw new IllegalArgumentException("无效的历史节点关系");
            nodes.put(node.id, node);
        }
        select(leaf);
    }

    public String leaf() { return leaf; }
    public Node node(String id) { return nodes.get(id); }
    public List<Node> nodes() { return new ArrayList<>(nodes.values()); }

    public void select(String id) {
        if (id != null && !nodes.containsKey(id)) throw new IllegalArgumentException("历史节点不存在");
        leaf = id;
    }

    public List<AgentLoop.Message> path() {
        List<AgentLoop.Message> result = new ArrayList<>();
        for (Node node = nodes.get(leaf); node != null; node = nodes.get(node.parentId)) result.add(node.message);
        Collections.reverse(result);
        return result;
    }

    /** A trimmed provider snapshot can start in the middle of the existing path. */
    public void merge(List<AgentLoop.Message> snapshot) {
        String parent = null;
        for (int i = 0; i < snapshot.size(); i++) {
            AgentLoop.Message message = snapshot.get(i);
            Node existing = nodes.get(message.id);
            if (existing != null) {
                // Context trimming can omit ancestors (including a retained system prefix).
                parent = existing.parentId;
            }
            nodes.put(message.id, new Node(parent, message));
            parent = message.id;
        }
        if (!snapshot.isEmpty()) leaf = parent;
    }

    public List<Row> rows(Set<String> folded) {
        Map<String, List<Node>> children = new LinkedHashMap<>();
        for (Node node : nodes.values()) children.computeIfAbsent(node.parentId, key -> new ArrayList<>()).add(node);
        Set<String> current = new HashSet<>();
        for (Node n = nodes.get(leaf); n != null; n = nodes.get(n.parentId)) current.add(n.id);
        // Reverse insertion order is child-before-parent, so counts need no recursive traversal.
        Map<String, Integer> counts = new LinkedHashMap<>();
        List<Node> reverse = nodes();
        Collections.reverse(reverse);
        for (Node n : reverse) if (n.parentId != null)
            counts.put(n.parentId, counts.getOrDefault(n.parentId, 0) + 1 + counts.getOrDefault(n.id, 0));
        List<Row> result = new ArrayList<>();
        List<Node> stack = new ArrayList<>();
        List<Integer> depths = new ArrayList<>();
        push(children.get(null), 0, current, stack, depths);
        while (!stack.isEmpty()) {
            int last = stack.size() - 1;
            Node n = stack.remove(last);
            int depth = depths.remove(last);
            result.add(new Row(n, depth, counts.getOrDefault(n.id, 0), current.contains(n.id)));
            if (!folded.contains(n.id)) {
                List<Node> next = children.get(n.id);
                List<Node> siblings = children.get(n.parentId);
                // A fork's alternative inputs are peers; each alternative's body steps in once.
                boolean branchBody = siblings != null && siblings.size() > 1;
                push(next, depth + (next != null && (next.size() > 1 || branchBody) ? 1 : 0),
                        current, stack, depths);
            }
        }
        return result;
    }

    private static void push(List<Node> children, int depth, Set<String> current,
            List<Node> stack, List<Integer> depths) {
        if (children == null) return;
        List<Node> ordered = new ArrayList<>(children);
        ordered.sort((a, b) -> Boolean.compare(current.contains(b.id), current.contains(a.id)));
        for (int i = ordered.size() - 1; i >= 0; i--) {
            stack.add(ordered.get(i));
            depths.add(depth);
        }
    }
}
