package com.example.launcherprobe;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

/** Main-thread facade over sessions, the durable mailbox and native routines. No second Bot entity. */
final class BotManager {
    private static BotManager instance;
    private final Context context;
    private final ChatCoordinator coordinator;
    private final ChatStore store;
    private final BotMailbox mailbox;
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean pumping;
    private String lastError = "";
    private long workspaceRevision;

    static synchronized BotManager get(Context context) throws Exception {
        if (instance == null) instance = new BotManager(context.getApplicationContext());
        return instance;
    }
    static void start(Context context) {
        try { get(context).wake(); }
        catch (Exception error) { Log.e("SessionBots", "Bot mailbox unavailable", error); }
    }
    private BotManager(Context context) throws Exception {
        this.context = context; coordinator = ChatCoordinator.get(context); store = coordinator.store();
        mailbox = new BotMailbox(new BotMailboxFile(new File(context.getFilesDir(), "bot-mailbox.bin")));
        mailbox.recover();
        for (BotMailbox.Delivery d : mailbox.snapshot()) if (!d.pending()) rememberDelivery(d);
        coordinator.addListener((messages, event) -> onEvent(messages, event));
        main.post(() -> {
            try {
                ScheduledTasks.get(context).reconcileMailbox(mailbox.snapshot());
            } catch (Exception error) { fail(error); }
        });
    }
    private static void requireMain() {
        if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("Bot 操作必须在主线程串行执行");
    }
    /** Host binds actor/request; caller identity is never read from model arguments. */
    JSONObject execute(String actor, String requestId, String callId, JSONObject args) throws Exception {
        requireMain();
        if (!coordinator.acceptsBotCall(actor, requestId)) throw new IllegalStateException("Bot 请求已结束或已取消");
        return action(actor, requestId, callId, args);
    }
    JSONObject userAction(String actor, String callId, JSONObject args) throws Exception {
        requireMain(); return action(actor, "user", callId, args);
    }
    private JSONObject action(String actor, String requestId, String callId, JSONObject args) throws Exception {
        if (args == null) throw new IllegalArgumentException("缺少 Bot 参数");
        for (String key : List.of("callerId", "ownerId", "sessionId", "conversationId", "requestId"))
            if (args.has(key)) throw new SecurityException("不能指定调用者身份");
        String action = args.getString("action"); BotPolicy.requireAction(action);
        store.ensureBotSession(actor);
        ScheduledTasks schedules = ScheduledTasks.get(context);
        return switch (action) {
            case "list" -> list(args.optString("query", ""));
            case "self" -> { JSONObject profile = store.botProfile(actor); profile.remove("history"); yield profile; }
            case "create" -> create(actor, "create:" + actor + ":" + requestId + ":" + callId, args);
            case "send" -> {
                String target = args.getString("targetId");
                if (!store.hasConversation(target)) throw new IllegalArgumentException("目标 bot 不存在，请先查找");
                if (store.isArchived(target)) throw new IllegalStateException("目标 bot 已归档，请由用户先恢复");
                BotMailbox.Delivery cause = mailbox.byRequest(requestId);
                BotMailbox.Delivery d = mailbox.enqueue("send:" + actor + ":" + requestId + ":" + callId,
                        actor, target, args.getString("message"), "bot", args.optBoolean("expectsReply", true),
                        cause, System.currentTimeMillis());
                coordinator.botChanged(target); wake(); yield delivery(d);
            }
            case "reply" -> {
                BotMailbox.Delivery parent = mailbox.byId(args.getString("messageId"));
                if (parent == null) throw new IllegalArgumentException("原消息不存在");
                BotPolicy.requireOwn(actor, parent.to());
                if (!store.hasConversation(parent.from()) || store.isArchived(parent.from()))
                    throw new IllegalStateException("来源 bot 已删除或归档");
                BotMailbox.Delivery d = mailbox.enqueue("reply:" + actor + ":" + requestId + ":" + callId,
                        actor, parent.from(), args.getString("message"), "reply", false, parent, System.currentTimeMillis());
                coordinator.botChanged(parent.from()); wake(); yield delivery(d);
            }
            case "role" -> {
                JSONObject profile = store.saveBotProfile(actor, null, BotPolicy.role(args.getString("rolePrompt")),
                        ScheduleRule.integer(args, "revision"), requestId.equals("user") ? "user" : "bot");
                coordinator.botChanged(actor); yield profile;
            }
            case "schedules" -> schedules.snapshotForBot(actor);
            case "schedule_save" -> {
                JSONObject input = new JSONObject(args.getJSONObject("schedule").toString());
                if (input.has("conversationId")) throw new SecurityException("不能指定其他 bot");
                if (input.has("id")) requireTaskOwner(actor, input.getString("id"));
                input.put("conversationId", actor);
                schedules.save(input); yield schedules.snapshotForBot(actor);
            }
            case "schedule_enable" -> {
                String id = args.getString("taskId"); requireTaskOwner(actor, id);
                schedules.setEnabled(id, ScheduleRule.integer(args, "revision"), args.getBoolean("enabled"));
                yield schedules.snapshotForBot(actor);
            }
            case "schedule_delete" -> {
                String id = args.getString("taskId"); requireTaskOwner(actor, id);
                schedules.delete(id, ScheduleRule.integer(args, "revision")); yield schedules.snapshotForBot(actor);
            }
            case "schedule_run" -> {
                String id = args.getString("taskId"); requireTaskOwner(actor, id);
                yield schedules.runNow(id, ScheduleRule.integer(args, "revision"), "manual:" + actor + ":" + requestId + ":" + callId);
            }
            default -> throw new IllegalArgumentException("不支持的 Bot 操作");
        };
    }
    JSONObject workspace() throws Exception {
        requireMain();
        return BotWorkspace.snapshot(context, mailbox.snapshot(), ++workspaceRevision, lastError);
    }
    JSONObject enqueueUser(String id, String body, String submissionId) throws Exception {
        requireMain();
        BotMailbox.requireText(submissionId, "提交编号", 128);
        if (!store.hasConversation(id) || store.isArchived(id)) throw new IllegalStateException("Bot 不存在或已归档");
        BotMailbox.Delivery d = mailbox.enqueue("user:" + id + ":" + submissionId, "user", id, body,
                "user", false, null, System.currentTimeMillis());
        coordinator.botChanged(id); wake(); return delivery(d);
    }
    void stop(String id) throws Exception {
        requireMain();
        mailbox.stopQueuedFor(id);
        ScheduledTasks.get(context).reconcileMailbox(mailbox.snapshot());
        coordinator.cancel(id); coordinator.botChanged(id);
    }
    JSONObject snapshot(String id) throws Exception {
        store.ensureBotSession(id);
        JSONArray messages = new JSONArray();
        for (BotMailbox.Delivery d : mailbox.snapshot()) if (d.to().equals(id) || d.from().equals(id)) messages.put(delivery(d));
        return new JSONObject().put("profile", store.botProfile(id)).put("messages", messages)
                .put("schedules", ScheduledTasks.get(context).snapshotForBot(id)).put("error", lastError);
    }
    private JSONObject list(String query) throws Exception {
        if (query.length() > 128) throw new IllegalArgumentException("查询过长");
        String search = query.toLowerCase(Locale.ROOT); JSONArray bots = new JSONArray();
        for (ChatStore.Conversation c : store.conversations()) {
            JSONObject profile = store.botProfile(c.id);
            if (!profile.getString("name").toLowerCase(Locale.ROOT).contains(search) && !c.id.contains(search)) continue;
            bots.put(new JSONObject().put("id", c.id).put("name", profile.getString("name"))
                    .put("busy", coordinator.botBusy(c.id)));
        }
        return new JSONObject().put("bots", bots);
    }
    private JSONObject create(String actor, String key, JSONObject args) throws Exception {
        String name = BotMailbox.requireText(args.getString("name"), "名称", 80).trim();
        String role = BotPolicy.role(args.optString("rolePrompt", ""));
        JSONArray tasks = args.optJSONArray("schedules");
        if (tasks != null && tasks.length() > 10) throw new IllegalArgumentException("一次最多创建 10 个定时任务");
        // Validate all definitions before publishing the new session.
        if (tasks != null) for (int i = 0; i < tasks.length(); i++) {
            JSONObject task = tasks.getJSONObject(i);
            if (task.has("id") || task.has("conversationId")) throw new IllegalArgumentException("初始任务不能引用已有任务或 bot");
            ScheduledTasks.validateDefinition(task);
        }
        String id = UUID.nameUUIDFromBytes(key.getBytes(StandardCharsets.UTF_8)).toString();
        if (store.hasConversation(id)) return new JSONObject().put("bot", store.botProfile(id)).put("alreadyCreated", true)
                .put("schedules", ScheduledTasks.get(context).snapshotForBot(id));
        if (store.conversations().size() + store.archivedConversations().size() >= 256)
            throw new IllegalStateException("Bot 数量已达 256，请由用户手动整理");
        store.createBotSession(id, name, role, store.piSelection(actor));
        JSONArray errors = new JSONArray();
        if (tasks != null) for (int i = 0; i < tasks.length(); i++) {
            try {
                JSONObject task = new JSONObject(tasks.getJSONObject(i).toString()).put("conversationId", id);
                ScheduledTasks.get(context).save(task);
            } catch (Exception error) { errors.put(new JSONObject().put("index", i).put("error", detail(error))); }
        }
        coordinator.botChanged(id);
        return new JSONObject().put("bot", store.botProfile(id)).put("scheduleErrors", errors)
                .put("schedules", ScheduledTasks.get(context).snapshotForBot(id));
    }
    private void requireTaskOwner(String actor, String taskId) throws Exception {
        JSONArray tasks = ScheduledTasks.get(context).snapshot().getJSONArray("tasks");
        for (int i = 0; i < tasks.length(); i++) {
            JSONObject task = tasks.getJSONObject(i);
            if (task.getString("id").equals(taskId)) { BotPolicy.requireOwn(actor, task.getString("conversationId")); return; }
        }
        throw new IllegalArgumentException("定时任务不存在");
    }
    BotMailbox.Delivery enqueueSchedule(String owner, String prompt, String key) throws Exception {
        requireMain();
        if (!store.hasConversation(owner) || store.isArchived(owner)) throw new IllegalStateException("所属 bot 不存在或已归档");
        BotMailbox.Delivery d = mailbox.enqueue(key, owner, owner, prompt, "schedule", false, null, System.currentTimeMillis());
        wake(); return d;
    }
    void wake() { main.post(this::pump); }
    private void pump() {
        requireMain(); if (pumping) return; pumping = true;
        try {
            while (mailbox.snapshot().stream().filter(d -> d.status().equals("running")).count() < 4) {
                BotMailbox.Delivery d = mailbox.next(id -> store.hasConversation(id) && !store.isArchived(id) && !coordinator.botBusy(id));
                if (d == null) break;
                d = mailbox.claim(d.id());
                try {
                    if (d.kind().equals("schedule")) ScheduledTasks.get(context).deliveryChanged(d);
                    String name = d.kind().equals("user") ? "你" : store.hasConversation(d.from()) ? store.botProfile(d.from()).getString("name") : "已删除的 bot";
                    JSONObject origin = delivery(d).put("name", name);
                    coordinator.sendBotInput(d.to(), BotPolicy.incoming(d, name), origin, d.requestId());
                } catch (Exception error) {
                    mailbox.finish(d.requestId(), "error", detail(error), System.currentTimeMillis());
                    rememberDelivery(mailbox.byId(d.id()));
                    if (d.kind().equals("schedule")) ScheduledTasks.get(context).deliveryChanged(mailbox.byId(d.id()));
                    coordinator.botChanged(d.to());
                }
            }
        } catch (Exception error) { fail(error); }
        finally { pumping = false; }
    }
    private void onEvent(List<AgentLoop.Message> messages, JSONObject event) {
        try {
            String type = event.optString("type"), id = event.optString("conversationId");
            if (type.equals("conversationDeleted")) {
                mailbox.cancelFor(id); ScheduledTasks.get(context).removeForBot(id);
            } else if (type.equals("conversationArchived")) {
                for (BotMailbox.Delivery d : mailbox.snapshot()) if (d.to().equals(id) && d.kind().equals("schedule")
                        && d.status().equals("queued")) {
                    ScheduledTasks.get(context).deliveryChanged(mailbox.cancelQueued(d.id(), "Bot 已归档，未补跑此任务"));
                }
            } else if (type.equals("end")) {
                JSONObject payload = event.optJSONObject("payload");
                String request = payload == null ? "" : payload.optString("finishedRequestId");
                BotMailbox.Delivery d = mailbox.byRequest(request);
                if (d != null && d.status().equals("running")) {
                    String result = ""; boolean inTurn = false;
                    for (AgentLoop.Message message : messages) {
                        if (message.id.equals(d.id())) { inTurn = true; continue; }
                        if (inTurn && message.role.equals("assistant") && !message.incomplete && message.content != null) result = message.content;
                    }
                    String status = payload.optString("status", "error");
                    if (!status.equals("completed")) result = "执行状态：" + status;
                    mailbox.finish(request, status, result, System.currentTimeMillis());
                    rememberDelivery(mailbox.byId(d.id()));
                    if (d.kind().equals("schedule")) ScheduledTasks.get(context).deliveryChanged(mailbox.byId(d.id()));
                }
            }
            if (type.equals("end") || type.startsWith("conversation") || type.equals("botChanged")) wake();
        } catch (Exception error) { fail(error); }
    }
    String deliveryIdForKey(String key) {
        BotMailbox.Delivery d = mailbox.byKey(key); return d == null ? "" : d.id();
    }
    void cancelQueuedSchedule(String deliveryId) throws Exception {
        BotMailbox.Delivery d = mailbox.byId(deliveryId);
        if (d != null && d.kind().equals("schedule")) ScheduledTasks.get(context).deliveryChanged(
                mailbox.cancelQueued(deliveryId, "任务已暂停或删除；未启动执行"));
    }
    void beforeDelete(String id) throws Exception {
        mailbox.cancelFor(id);
        for (BotMailbox.Delivery d : mailbox.snapshot()) if (d.to().equals(id) || d.from().equals(id)) rememberDelivery(d);
        ScheduledTasks.get(context).removeForBot(id);
    }
    private void rememberDelivery(BotMailbox.Delivery d) throws Exception {
        if (!store.hasConversation(d.to())) return;
        JSONObject previous = store.botOrigin(d.to(), d.id());
        if (previous != null && !previous.optString("status").equals(d.status()))
            store.saveBotOrigin(d.to(), d.id(), delivery(d).put("name", previous.optString("name")));
    }
    static JSONObject delivery(BotMailbox.Delivery d) throws Exception {
        return new JSONObject().put("id", d.id()).put("from", d.from()).put("to", d.to()).put("kind", d.kind())
                .put("replyTo", d.replyTo()).put("root", d.root()).put("status", d.status()).put("requestId", d.requestId())
                .put("createdAt", d.createdAt()).put("body", d.body()).put("error", d.error());
    }
    private void fail(Exception error) { lastError = detail(error); Log.e("SessionBots", lastError, error); }
    private static String detail(Exception error) { return error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage(); }
}
