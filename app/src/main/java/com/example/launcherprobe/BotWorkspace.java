package com.example.launcherprobe;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Public UI projection and trusted user actions. Never registered as a model tool. */
final class BotWorkspace {
    private BotWorkspace() { }

    static JSONObject snapshot(Context context, List<BotMailbox.Delivery> deliveries, long revision, String error) throws Exception {
        ChatCoordinator coordinator = ChatCoordinator.get(context);
        ChatStore store = coordinator.store();
        JSONObject schedules = ScheduledTasks.get(context).snapshot();
        List<ChatStore.Conversation> conversations = new ArrayList<>(store.conversations());
        conversations.addAll(store.archivedConversations());
        Map<String, String> names = new HashMap<>();
        for (ChatStore.Conversation c : conversations) names.put(c.id, store.botProfile(c.id).getString("name"));
        JSONArray bots = new JSONArray(), messages = new JSONArray(), routines = new JSONArray();
        Set<String> seen = new HashSet<>();
        JSONArray records = schedules.getJSONArray("records");
        for (BotMailbox.Delivery d : deliveries) {
            if (!names.containsKey(d.to()) && !names.containsKey(d.from())) continue;
            messages.put(delivery(BotManager.delivery(d), names, records)); seen.add(d.id());
        }
        for (ChatStore.Conversation c : conversations) {
            JSONObject profile = store.botProfile(c.id), selection = new JSONObject(store.piSelection(c.id));
            JSONObject card = coordinator.taskCard(c.id);
            boolean needsUser = card != null && !card.isNull("askUser");
            String activity = coordinator.botBusy(c.id) ? "working"
                    : card != null && "error".equals(card.optString("runStatus")) ? "error" : "idle";
            if (activity.equals("idle") && deliveries.stream().anyMatch(d -> d.pending() && d.to().equals(c.id))) activity = "waiting";
            JSONObject bot = new JSONObject().put("id", c.id).put("name", profile.getString("name"))
                    .put("rolePrompt", profile.getString("rolePrompt")).put("revision", profile.getInt("revision"))
                    .put("description", profile.optString("description")).put("avatar", profile.optJSONObject("avatar"))
                    .put("archived", c.archivedAt != 0).put("needsUser", needsUser).put("activity", activity)
                    .put("modelLabel", selection.optString("model", "默认模型"));
            bots.put(bot);
            JSONObject times = store.botMessageTimes(c.id);
            long order = store.createdAt(c.id);
            for (AgentLoop.Message m : store.load(c.id)) {
                order++;
                JSONObject origin = store.botOrigin(c.id, m.id);
                if (origin != null) {
                    if (seen.add(origin.getString("id"))) messages.put(delivery(origin, names, records));
                    order = Math.max(order, origin.getLong("createdAt"));
                    continue;
                }
                if (!(m.role.equals("user") || m.role.equals("assistant"))) continue;
                String body = m.content == null ? "" : m.content;
                if (body.isEmpty() && !m.attachments.isEmpty()) body = "[附件；请在完整会话中查看]";
                if (body.isEmpty()) continue;
                long createdAt = times.optLong(m.id, order);
                order = Math.max(order, createdAt);
                JSONObject source = m.role.equals("user") ? new JSONObject().put("kind", "user")
                        : new JSONObject().put("kind", "assistant").put("sessionId", c.id).put("name", names.get(c.id));
                messages.put(new JSONObject().put("id", c.id + ":" + m.id).put("toSessionId", c.id)
                        .put("body", body).put("source", source).put("createdAt", createdAt)
                        .put("timeKnown", times.has(m.id)).put("status", m.incomplete ? (coordinator.botBusy(c.id) ? "running" : "interrupted") : "completed"));
            }
        }
        JSONArray tasks = schedules.getJSONArray("tasks");
        for (int i = 0; i < tasks.length(); i++) {
            JSONObject t = tasks.getJSONObject(i);
            ScheduleRule rule = ScheduleRule.fromJson(t);
            String label = switch (rule.repeat) {
                case "weekly" -> "每周" + "一二三四五六日".charAt(rule.weekday - 1);
                case "monthly" -> "每月 " + rule.monthDay + " 日";
                default -> "每天";
            };
            String lastStatus = "";
            for (int j = 0; j < records.length(); j++) if (t.getString("id").equals(records.getJSONObject(j).optString("taskId"))) {
                lastStatus = records.getJSONObject(j).getString("status"); break;
            }
            routines.put(new JSONObject().put("id", t.getString("id")).put("ownerSessionId", t.getString("conversationId"))
                    .put("title", t.getString("title")).put("prompt", t.getString("prompt")).put("revision", t.getInt("revision"))
                    .put("enabled", t.getBoolean("enabled")).put("scheduleLabel", label + " " + rule.time)
                    .put("repeat", rule.repeat).put("time", rule.time.toString()).put("weekday", rule.weekday).put("monthDay", rule.monthDay)
                    .put("timeZone", schedules.getString("timeZone")).put("nextRunAt", t.optLong("nextRunAt"))
                    .put("lastStatus", lastStatus));
        }
        String notice = error;
        if (!schedules.getBoolean("exactAlarmGranted")) notice += " 定时触发需要精确闹钟权限，请在设置 → 定时任务中授权。";
        if (!schedules.getString("schedulingError").isEmpty()) notice += " " + schedules.getString("schedulingError");
        JSONObject view = new JSONObject().put("version", 1).put("revision", revision).put("bots", bots)
                .put("messages", messages).put("routines", routines).put("notice", notice.trim());
        JSONObject capabilities = new JSONObject();
        for (String key : List.of("send", "stop", "create", "profile", "routines", "restore", "archive", "delete")) capabilities.put(key, true);
        return new JSONObject().put("snapshot", view).put("capabilities", capabilities);
    }

    private static JSONObject delivery(JSONObject d, Map<String, String> names, JSONArray records) throws Exception {
        String kind = d.getString("kind"), from = d.getString("from");
        JSONObject source;
        if (kind.equals("user")) source = new JSONObject().put("kind", "user");
        else if (kind.equals("schedule")) {
            String taskId = d.getString("id"), title = "定时任务";
            for (int i = 0; i < records.length(); i++) {
                JSONObject r = records.getJSONObject(i);
                if (d.getString("id").equals(r.optString("deliveryId"))) { taskId = r.getString("taskId"); title = r.getString("title"); break; }
            }
            source = new JSONObject().put("kind", "routine").put("routineId", taskId).put("name", title);
        } else source = new JSONObject().put("kind", "bot").put("sessionId", from)
                .put("name", names.getOrDefault(from, d.optString("name", "已删除的 bot")));
        JSONObject result = new JSONObject().put("id", d.getString("id")).put("toSessionId", d.getString("to"))
                .put("source", source).put("body", d.getString("body")).put("createdAt", d.getLong("createdAt"))
                .put("status", d.optString("status", "unknown"));
        if (!d.optString("root").isEmpty()) result.put("chainId", d.getString("root"));
        if (!d.optString("replyTo").isEmpty()) result.put("replyToMessageId", d.getString("replyTo"));
        return result;
    }

    static void validateAppearance(JSONObject input) throws org.json.JSONException {
        String description = input.getString("description");
        if (description.length() > 240) throw new IllegalArgumentException("简介最多 240 个字符");
        JSONObject avatar = input.getJSONObject("avatar");
        if (!Set.of("pebble", "squircle", "drop", "cloud", "hex", "pill", "leaf", "star").contains(avatar.getString("shape"))
                || !Set.of("orange", "green", "blue", "violet", "rose", "gold").contains(avatar.getString("color")))
            throw new IllegalArgumentException("请选择有效头像和颜色");
    }

    static JSONObject action(Context context, String action, JSONObject input) throws Exception {
        ChatCoordinator coordinator = ChatCoordinator.get(context);
        ChatStore store = coordinator.store(); BotManager manager = BotManager.get(context);
        ScheduledTasks schedules = ScheduledTasks.get(context);
        switch (action) {
            case "sendUserMessage": return manager.enqueueUser(input.getString("toSessionId"), input.getString("body"), input.getString("submissionId"));
            case "stop": manager.stop(input.getString("id")); break;
            case "createBot": {
                validateAppearance(input);
                String name = BotMailbox.requireText(input.getString("name").trim(), "名称", 80);
                String role = BotPolicy.role(input.getString("rolePrompt"));
                JSONArray initial = input.getJSONArray("routines"), definitions = new JSONArray();
                if (initial.length() > 10) throw new IllegalArgumentException("最多 10 个初始任务");
                for (int i = 0; i < initial.length(); i++) {
                    JSONObject definition = routineDefinition(initial.getJSONObject(i), null);
                    ScheduledTasks.validateDefinition(definition); definitions.put(definition);
                }
                if (store.conversations().size() + store.archivedConversations().size() >= 256) throw new IllegalStateException("Bot 数量已达 256");
                String id = UUID.randomUUID().toString();
                store.createBotSession(id, name, role, store.piSelection(store.activeId()));
                try {
                    store.saveBotProfile(id, name, role, 1, "user", input);
                    for (int i = 0; i < definitions.length(); i++) schedules.save(definitions.getJSONObject(i).put("conversationId", id));
                } catch (Exception error) {
                    // No turn has started: do not leave a half-created bot after initial setup fails.
                    try { coordinator.deleteConversation(id); } catch (Exception rollback) { error.addSuppressed(rollback); }
                    throw error;
                }
                coordinator.botChanged(id); return new JSONObject().put("id", id);
            }
            case "updateBot": {
                String id = existing(store, input);
                JSONObject profile = store.saveBotProfile(id, input.getString("name"), input.getString("rolePrompt"),
                        ScheduleRule.integer(input, "revision"), "user", input);
                coordinator.botChanged(id); return profile;
            }
            case "archive": {
                String id = existing(store, input);
                if (coordinator.botBusy(id)) throw new IllegalStateException("请先停止此 bot，再归档");
                coordinator.archiveConversation(id); break;
            }
            case "restore": coordinator.restoreConversation(existing(store, input)); break;
            case "deleteBot": {
                String id = existing(store, input);
                if (store.botProfile(id).getInt("revision") != ScheduleRule.integer(input, "revision")) throw new IllegalStateException("角色已变更，请刷新后重试");
                coordinator.deleteConversation(id); break;
            }
            case "saveRoutine": {
                JSONObject previous = input.has("id") ? task(schedules, input.getString("id")) : null;
                String owner = input.getString("ownerSessionId");
                if (!store.hasConversation(owner) || store.isArchived(owner)) throw new IllegalStateException("所属 bot 不存在或已归档");
                if (previous != null) BotPolicy.requireOwn(owner, previous.getString("conversationId"));
                return schedules.save(routineDefinition(input, previous).put("conversationId", owner));
            }
            case "setRoutineEnabled": return schedules.setEnabled(input.getString("id"), ScheduleRule.integer(input, "revision"), input.getBoolean("enabled"));
            case "runRoutine": return schedules.runNow(input.getString("id"), ScheduleRule.integer(input, "revision"), "ui:" + UUID.randomUUID());
            default: throw new IllegalArgumentException("未知工作台操作");
        }
        return new JSONObject();
    }

    private static String existing(ChatStore store, JSONObject input) throws Exception {
        String id = input.getString("id");
        if (!store.hasConversation(id)) throw new IllegalArgumentException("Bot 不存在");
        return id;
    }
    private static JSONObject task(ScheduledTasks schedules, String id) throws Exception {
        JSONArray tasks = schedules.snapshot().getJSONArray("tasks");
        for (int i = 0; i < tasks.length(); i++) if (id.equals(tasks.getJSONObject(i).getString("id"))) return tasks.getJSONObject(i);
        throw new IllegalArgumentException("定时任务不存在");
    }
    private static JSONObject routineDefinition(JSONObject input, JSONObject previous) throws Exception {
        JSONObject definition = previous == null ? new JSONObject() : new JSONObject(previous.toString());
        definition.put("title", input.getString("title")).put("prompt", input.getString("prompt"));
        if (previous != null) definition.put("revision", ScheduleRule.integer(input, "revision"));
        if (input.has("schedule")) {
            JSONObject rule = input.getJSONObject("schedule");
            String kind = rule.getString("kind");
            int hour = ScheduleRule.integer(rule, "hour"), minute = ScheduleRule.integer(rule, "minute");
            if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new IllegalArgumentException("无效时间");
            if (rule.has("timeZone") && !java.time.ZoneId.of(rule.getString("timeZone")).getRules().equals(java.time.ZoneId.systemDefault().getRules()))
                throw new IllegalArgumentException("原生定时任务跟随手机时区，请选择手机当前时区");
            definition.put("repeat", kind).put("time", String.format(java.util.Locale.ROOT, "%02d:%02d", hour, minute))
                    .put("weekday", kind.equals("weekly") ? ScheduleRule.integer(rule, "weekday") : 1)
                    .put("monthDay", kind.equals("monthly") ? ScheduleRule.integer(rule, "monthDay") : 1);
        }
        ScheduledTasks.validateDefinition(definition);
        return definition;
    }
}
