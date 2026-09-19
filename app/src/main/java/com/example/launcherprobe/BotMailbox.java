package com.example.launcherprobe;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.function.Predicate;

/** Durable, bounded delivery ledger. It never starts a model or performs a phone action. */
public final class BotMailbox {
    public static final int MAX_BODY = 16000, MAX_PENDING = 64, MAX_RECORDS = 256;
    public static final int MAX_HOPS = 8, MAX_THREAD_MESSAGES = 32;
    public interface Storage {
        List<Delivery> read() throws IOException;
        void write(List<Delivery> deliveries) throws IOException;
    }
    public record Delivery(String id, String key, String from, String to, String body,
            String kind, String replyTo, String root, int depth, boolean expectsReply,
            long createdAt, String status, String requestId, String error) {
        public boolean pending() { return status.equals("queued") || status.equals("running"); }
        Delivery status(String next, String request, String detail) {
            return new Delivery(id, key, from, to, body, kind, replyTo, root, depth,
                    expectsReply, createdAt, next, request, detail);
        }
    }
    private final Storage storage;
    private List<Delivery> deliveries;

    public BotMailbox(Storage storage) throws IOException {
        this.storage = Objects.requireNonNull(storage);
        deliveries = List.copyOf(storage.read());
        validate(deliveries);
    }
    public synchronized List<Delivery> snapshot() { return List.copyOf(deliveries); }
    public synchronized Delivery byId(String id) {
        return deliveries.stream().filter(d -> d.id().equals(id)).findFirst().orElse(null);
    }
    public synchronized Delivery byKey(String key) {
        return deliveries.stream().filter(d -> d.key().equals(key)).findFirst().orElse(null);
    }
    public synchronized Delivery byRequest(String id) {
        if (id == null || id.isEmpty()) return null;
        return deliveries.stream().filter(d -> d.requestId().equals(id)).findFirst().orElse(null);
    }
    public synchronized Delivery enqueue(String key, String from, String to, String body,
            String kind, boolean expectsReply, Delivery cause, long now) throws IOException {
        requireText(key, "投递标识", 512); requireText(from, "来源", 256);
        requireText(to, "目标", 256); requireText(body, "消息", MAX_BODY);
        if (!Set.of("bot", "reply", "schedule", "user").contains(kind)) throw new IllegalArgumentException("未知消息来源");
        if (kind.equals("reply") && (cause == null || !cause.to().equals(from) || !cause.from().equals(to)
                || !(cause.kind().equals("bot") || cause.kind().equals("reply"))))
            throw new IllegalArgumentException("只能回复发给自己的 bot 消息");
        Delivery duplicate = byKey(key);
        if (duplicate != null) {
            if (!duplicate.from().equals(from) || !duplicate.to().equals(to)
                    || !duplicate.body().equals(body) || !duplicate.kind().equals(kind)
                    || duplicate.expectsReply() != expectsReply) {
                throw new IllegalArgumentException("投递标识已用于不同请求");
            }
            return duplicate;
        }
        if (from.equals(to) && (kind.equals("bot") || kind.equals("reply"))) throw new IllegalArgumentException("不能向自己发送 bot 消息；请使用定时任务");
        String id = UUID.randomUUID().toString();
        String root = cause == null ? id : cause.root();
        int depth = cause == null ? 0 : cause.depth() + 1;
        long threadCount = deliveries.stream().filter(d -> d.root().equals(root)).count();
        if (depth >= MAX_HOPS || threadCount >= MAX_THREAD_MESSAGES)
            throw new IllegalStateException("本次协作已达到消息预算，请由用户发起新的请求");
        List<Delivery> next = room(deliveries, root, 1);
        if (next.stream().filter(Delivery::pending).count() >= MAX_PENDING)
            throw new IllegalStateException("待处理消息过多，请稍后重试");
        Delivery delivery = new Delivery(id, key, from, to, body, kind, kind.equals("reply") ? cause.id() : "", root, depth,
                expectsReply && kind.equals("bot"), now, "queued", "", "");
        next.add(delivery);
        commit(next);
        return delivery;
    }
    public synchronized Delivery next(Predicate<String> available) {
        return deliveries.stream().filter(d -> d.status().equals("queued") && available.test(d.to()))
                .sorted(java.util.Comparator.comparingInt(d -> d.kind().equals("user") ? 0 : 1))
                .findFirst().orElse(null);
    }
    /** Persist a request identity BEFORE dispatch; a crash in the dispatch gap is never blindly replayed. */
    public synchronized Delivery claim(String id) throws IOException {
        Delivery delivery = require(id);
        if (!delivery.status().equals("queued")) throw new IllegalStateException("消息已被处理");
        if (deliveries.stream().anyMatch(d -> d.to().equals(delivery.to()) && d.status().equals("running")))
            throw new IllegalStateException("此 bot 已有投递正在执行");
        Delivery claimed = delivery.status("running", UUID.randomUUID().toString(), "");
        replace(claimed);
        return claimed;
    }
    /** Completion is a receipt only. Only an explicit send/reply creates another bot message. */
    public synchronized boolean finish(String requestId, String status, String body, long now) throws IOException {
        Delivery delivery = byRequest(requestId);
        if (delivery == null || !delivery.status().equals("running")) return false;
        if (!Set.of("completed", "error", "aborted", "interrupted").contains(status))
            throw new IllegalArgumentException("无效结束状态");
        String result = body == null ? "" : body;
        if (result.length() > MAX_BODY) result = result.substring(0, MAX_BODY - 40)
                + "\n[回复已截断；完整结果保留在来源 bot 会话中]";
        List<Delivery> next = new ArrayList<>(deliveries);
        int index = index(delivery.id());
        next.set(index, delivery.status(status, requestId, status.equals("completed") ? "" : result));
        commit(next);
        return true;
    }
    /** On process restart, report uncertainty rather than repeat possibly side-effectful work. */
    public synchronized int recover() throws IOException {
        List<Delivery> running = deliveries.stream().filter(d -> d.status().equals("running"))
                .collect(java.util.stream.Collectors.toList());
        for (Delivery d : running) finish(d.requestId(), "interrupted", "应用进程中断，执行结果不确定；未自动重试", System.currentTimeMillis());
        return running.size();
    }
    public synchronized Delivery cancelQueued(String id, String reason) throws IOException {
        Delivery d = require(id);
        if (!d.status().equals("queued")) return d;
        Delivery next = d.status("cancelled", d.requestId(), reason); replace(next); return next;
    }

    /** User stop cancels queued work, not a peer's already-running turn. */
    public synchronized void stopQueuedFor(String sessionId) throws IOException {
        List<Delivery> next = new ArrayList<>();
        for (Delivery d : deliveries) next.add(d.status().equals("queued")
                && (d.to().equals(sessionId) || d.from().equals(sessionId))
                ? d.status("cancelled", d.requestId(), "用户已停止此 bot") : d);
        commit(next);
    }
    public synchronized void cancelFor(String sessionId) throws IOException {
        List<Delivery> next = new ArrayList<>();
        for (Delivery d : deliveries) next.add(d.pending() && (d.to().equals(sessionId) || d.from().equals(sessionId))
                ? d.status("cancelled", d.requestId(), "关联 bot 已删除") : d);
        commit(next);
    }
    public synchronized boolean pendingKey(String key) {
        Delivery d = byKey(key); return d != null && d.pending();
    }
    private Delivery require(String id) {
        Delivery d = byId(id); if (d == null) throw new IllegalArgumentException("消息不存在"); return d;
    }
    private int index(String id) {
        for (int i = 0; i < deliveries.size(); i++) if (deliveries.get(i).id().equals(id)) return i;
        throw new IllegalArgumentException("消息不存在");
    }
    private void replace(Delivery delivery) throws IOException {
        List<Delivery> next = new ArrayList<>(deliveries); next.set(index(delivery.id()), delivery); commit(next);
    }
    private void commit(List<Delivery> next) throws IOException {
        validate(next); List<Delivery> immutable = List.copyOf(next);
        storage.write(immutable); // Publish only after durable storage succeeds.
        deliveries = immutable;
    }
    private static List<Delivery> room(List<Delivery> source, String protectedRoot, int slots) {
        List<Delivery> next = new ArrayList<>(source);
        Set<String> activeRoots = new HashSet<>();
        for (Delivery d : source) if (d.pending()) activeRoots.add(d.root());
        activeRoots.add(protectedRoot);
        while (next.size() + slots > MAX_RECORDS) {
            int candidate = -1;
            for (int i = 0; i < next.size(); i++) if (!next.get(i).pending()
                    && !activeRoots.contains(next.get(i).root())) { candidate = i; break; }
            if (candidate < 0) throw new IllegalStateException("投递记录已满；未丢弃待处理消息");
            next.remove(candidate);
        }
        return next;
    }
    private static void validate(List<Delivery> list) throws IOException {
        if (list.size() > MAX_RECORDS) throw new IOException("Bot 投递记录数量无效");
        Set<String> ids = new HashSet<>(), keys = new HashSet<>(), runningTargets = new HashSet<>();
        for (Delivery d : list) {
            if (d == null || d.id().isBlank() || !ids.add(d.id()) || !keys.add(d.key())
                    || d.body().length() > MAX_BODY || d.depth() < 0 || d.depth() >= MAX_HOPS
                    || !Set.of("queued", "running", "completed", "error", "aborted", "interrupted", "cancelled").contains(d.status())
                    || !Set.of("bot", "schedule", "reply", "user").contains(d.kind())
                    || (d.kind().equals("reply") && d.expectsReply())
                    || (d.status().equals("running") && (d.requestId().isBlank() || !runningTargets.add(d.to()))))
                throw new IOException("Bot 投递记录损坏；拒绝静默重置");
        }
    }
    public static String requireText(String value, String field, int max) {
        if (value == null || value.isBlank() || value.length() > max)
            throw new IllegalArgumentException(field + "长度需为 1–" + max);
        return value;
    }
}
