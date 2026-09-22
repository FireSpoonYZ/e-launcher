import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const repeat = Type.Union(["daily", "weekly", "monthly"].map((value) => Type.Literal(value)));
const time = Type.String({ pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$", description: "24 小时制 HH:mm" });
const title = Type.String({ minLength: 1, maxLength: 80, description: "任务名称，1–80 个字符" });
const prompt = Type.String({ minLength: 1, maxLength: 8000, description: "到点后发给助手执行的指令" });
const weekday = Type.Optional(Type.Integer({ minimum: 1, maximum: 7,
  description: "周几，1 为周一，7 为周日；repeat 为 weekly 时必填" }));
const monthDay = Type.Optional(Type.Integer({ minimum: 1, maximum: 31,
  description: "每月几号；repeat 为 monthly 时必填。该日不存在则跳过，不顺延" }));
const id = Type.String({ minLength: 1, description: "任务 id，来自 list" });
const revision = Type.Integer({ minimum: 1, description: "当前 revision，来自 list；不一致时更新会被拒绝" });

/** The host supplies the scheduled-task bridge through this loader's event bus. */
export default function scheduleTool(pi) {
  const bridge = {};
  pi.events.emit("schedule-tool:bridge", bridge);
  if (typeof bridge.request !== "function") throw new Error("schedule-tool 需要 Android 宿主提供原生 bridge");
  const request = bridge.request;
  pi.registerTool(defineTool({
    name: "schedule_task",
    label: "定时任务",
    description: "管理本机定时任务。用户说每天、每周或每月在某时刻做某事（例如“每天早上8点总结新闻”）时，用 create 创建。title 是简短任务名；prompt 是到点后原样交给助手执行的指令；repeat 为 daily、weekly 或 monthly；time 为 24 小时制 HH:mm。weekly 必须提供 weekday（1 是周一，7 是周日）；monthly 必须提供 monthDay（1–31，当月没有该日则跳过，不顺延）。查看用 list。修改或删除前必须先 list，并带上返回的 id 和 revision；update 只传要改的字段，未传字段保持原值，启用或暂停也保持。revision 不匹配说明任务已被改过，需要重新 list。不要编造 id 或 revision，也不要改用户没有点名的任务。返回的 exactAlarmGranted 为 false 或 schedulingError 非空时，任务只是已保存，系统闹钟未排上，不要说已保证到点执行；请用户到系统「闹钟与提醒」授权。失败、取消或超时后先 list，不要立刻重复提交。",
    parameters: Type.Union([
      Type.Object({ action: Type.Literal("list") }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("create"), title, prompt, repeat, time, weekday, monthDay },
        { additionalProperties: false }),
      Type.Object({
        action: Type.Literal("update"), id, revision,
        title: Type.Optional(title), prompt: Type.Optional(prompt), repeat: Type.Optional(repeat),
        time: Type.Optional(time), weekday, monthDay,
      }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("delete"), id, revision }, { additionalProperties: false }),
    ]),
    async execute(_toolCallId, arguments_, signal) {
      signal?.throwIfAborted();
      const { action, ...params } = arguments_;
      const result = await request(action, params, signal);
      if (result == null || typeof result !== "object" || Array.isArray(result)) throw new Error("定时任务响应无效");
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  }));
}
