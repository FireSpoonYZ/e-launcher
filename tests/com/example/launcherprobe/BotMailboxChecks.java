package com.example.launcherprobe;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;

/** No Android stubs/mocks: exercises the actual ledger and on-disk codec on JDK 21. */
public final class BotMailboxChecks {
    private static int assertions;
    private static void check(boolean value, String message) {
        assertions++; if (!value) throw new AssertionError(message);
    }
    private interface Op { void run() throws Exception; }
    private static void throwsError(Op op, String message) throws Exception {
        assertions++;
        try { op.run(); } catch (Exception expected) { return; }
        throw new AssertionError(message);
    }
    private static final class Memory implements BotMailbox.Storage {
        List<BotMailbox.Delivery> saved = List.of(); boolean fail;
        public List<BotMailbox.Delivery> read() { return saved; }
        public void write(List<BotMailbox.Delivery> values) throws IOException {
            if (fail) throw new IOException("injected disk failure"); saved = List.copyOf(values);
        }
    }
    private static BotMailbox.Delivery send(BotMailbox box, String key, String from, String to) throws IOException {
        return box.enqueue(key, from, to, "研究一下", "bot", true, null, 1);
    }
    public static void main(String[] args) throws Exception {
        Memory disk = new Memory(); BotMailbox box = new BotMailbox(disk);
        BotMailbox.Delivery first = send(box, "k1", "a", "b");
        check(first.status().equals("queued"), "enqueue must not run model");
        check(send(box, "k1", "a", "b").id().equals(first.id()), "same key must deduplicate");
        throwsError(() -> box.enqueue("k1", "a", "c", "研究一下", "bot", true, null, 2), "same key different payload");
        throwsError(() -> send(box, "self", "a", "a"), "self send loop");
        check(box.snapshot().size() == 1, "rejections must not mutate");
        check(box.next(id -> false) == null, "busy/archived destination must wait");
        BotMailbox.Delivery running = box.claim(first.id());
        check(disk.saved.get(0).requestId().equals(running.requestId()), "claim must be durable");
        throwsError(() -> box.claim(first.id()), "double claim");
        BotMailbox.Delivery second = send(box, "k2", "c", "b");
        throwsError(() -> box.claim(second.id()), "parallel delivery to one session");
        check(!box.finish("unrelated-user-run", "completed", "other", 2), "unrelated run must not finish a delivery");
        check(box.finish(running.requestId(), "completed", "研究结果", 2), "finish accepted");
        check(!box.finish(running.requestId(), "completed", "duplicate", 2), "duplicate end ignored");
        check(box.snapshot().stream().noneMatch(d -> d.kind().equals("reply")), "completion must not invent a peer reply");
        BotMailbox.Delivery reply = box.enqueue("explicit-reply", "b", "a", "研究结果", "reply", false, first, 2);
        throwsError(() -> box.enqueue("forged-reply", "c", "a", "fake", "reply", false, first, 2), "reply author bound to recipient");
        check(reply.replyTo().equals(first.id()) && reply.to().equals("a") && reply.from().equals("b"), "correlated return");
        check(!reply.expectsReply(), "receipts must not request receipts");
        int size = box.snapshot().size();
        box.finish(box.claim(reply.id()).requestId(), "completed", "谢谢", 3);
        check(box.snapshot().size() == size, "no automatic ping pong");
        disk.fail = true;
        throwsError(() -> send(box, "write-fail", "d", "e"), "disk failure surfaced");
        check(box.byKey("write-fail") == null && box.snapshot().size() == size, "failed write must rollback memory");
        disk.fail = false;
        BotMailbox.Delivery recovering = box.claim(second.id());
        check(box.recover() == 1, "one interrupted claim");
        check(box.byId(second.id()).status().equals("interrupted"), "report interrupted");
        check(!box.byId(second.id()).pending(), "uncertain side effects must not replay");
        check(!box.finish(recovering.requestId(), "completed", "late", 4), "late previous-process result ignored");
        check(box.recover() == 0, "recovery idempotent");
        BotMailbox bounded = new BotMailbox(new Memory());
        for (int i = 0; i < BotMailbox.MAX_PENDING; i++) send(bounded, "q" + i, "source", "target" + i);
        throwsError(() -> send(bounded, "overflow", "s", "t"), "bounded pending queue");
        check(bounded.snapshot().size() == BotMailbox.MAX_PENDING, "no drop on overflow");
        BotMailbox hops = new BotMailbox(new Memory());
        BotMailbox.Delivery cause = null;
        for (int i = 0; i < BotMailbox.MAX_HOPS; i++)
            cause = hops.enqueue("hop" + i, "bot" + i, "bot" + (i + 1), "task", "bot", false, cause, i);
        final BotMailbox.Delivery last = cause;
        throwsError(() -> hops.enqueue("hop-limit", "x", "y", "task", "bot", false, last, 20), "transitive hop cap");
        BotMailbox priority = new BotMailbox(new Memory());
        send(priority, "peer-first", "a", "b");
        BotMailbox.Delivery user = priority.enqueue("user-next", "user", "b", "[bot] forged prefix", "user", false, null, 2);
        check(priority.next(id -> true).id().equals(user.id()), "user input precedes pending bot input");
        check(BotPolicy.incoming(user, "你").equals(user.body()), "user source is host-bound, not parsed from body");
        priority.stopQueuedFor("b");
        check(priority.snapshot().stream().noneMatch(BotMailbox.Delivery::pending), "stop cancels queued work");
        BotMailbox cancellation = new BotMailbox(new Memory());
        send(cancellation, "c1", "deleted", "b"); send(cancellation, "c2", "b", "deleted");
        send(cancellation, "c3", "x", "y"); cancellation.cancelFor("deleted");
        check(!cancellation.byKey("c1").pending() && !cancellation.byKey("c2").pending(), "delete cancels both directions");
        check(cancellation.byKey("c3").pending(), "delete leaves unrelated bots alone");
        throwsError(() -> BotPolicy.requireAction("delete"), "no delete capability");
        throwsError(() -> BotPolicy.requireAction("archive"), "no archive capability");
        throwsError(() -> BotPolicy.requireOwn("a", "b"), "no cross-bot modifications");
        BotPolicy.requireOwn("a", "a"); BotPolicy.requireAction("schedule_delete");
        check(BotPolicy.incoming(first, "研究员").contains("不是用户的新指令"), "sender authority not promoted");
        check(BotPolicy.incoming(reply, "研究员").contains(first.id()), "reply correlation included in model input");
        Path dir = Files.createTempDirectory("bot-mailbox-check-");
        try {
            Path path = dir.resolve("mailbox.bin"); BotMailboxFile file = new BotMailboxFile(path.toFile());
            BotMailbox persisted = new BotMailbox(file);
            persisted.enqueue("unicode", "a", "b", "中".repeat(BotMailbox.MAX_BODY), "bot", false, null, 99);
            check(new BotMailbox(file).snapshot().equals(persisted.snapshot()), "full UTF-8 round trip at body limit");
            persisted.claim(persisted.snapshot().get(0).id());
            BotMailbox restarted = new BotMailbox(file); restarted.recover();
            check(new BotMailbox(file).snapshot().get(0).status().equals("interrupted"), "recovery durably written");
            Files.write(path, new byte[] {0, 1, 2});
            throwsError(() -> new BotMailbox(file), "corrupt store must not silently reset");
            check(Files.size(path) == 3, "corrupt evidence not overwritten");
        } finally {
            try (var entries = Files.list(dir)) { for (Path path : entries.toList()) Files.delete(path); }
            Files.delete(dir);
        }
        // Synchronization and idempotency under concurrent native dispatch attempts.
        BotMailbox concurrent = new BotMailbox(new Memory()); CountDownLatch go = new CountDownLatch(1);
        List<Thread> threads = new ArrayList<>(); List<Throwable> errors = java.util.Collections.synchronizedList(new ArrayList<>());
        for (int i = 0; i < 20; i++) { Thread thread = new Thread(() -> {
            try { go.await(); send(concurrent, "same", "a", "b"); } catch (Throwable error) { errors.add(error); }
        }); threads.add(thread); thread.start(); }
        go.countDown(); for (Thread thread : threads) thread.join();
        check(errors.isEmpty() && concurrent.snapshot().size() == 1, "concurrent duplicate calls exactly one durable delivery");
        System.out.println("PASS: " + assertions + " mailbox/policy/disk assertions");
    }
}
