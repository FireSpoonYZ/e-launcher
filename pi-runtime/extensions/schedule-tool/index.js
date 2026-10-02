import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const repeat = Type.Union(["once", "daily", "weekly", "monthly", "statutoryWorkday", "statutoryHoliday"].map((value) => Type.Literal(value)));
const time = Type.String({ pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$", description: "设备时区下的 24 小时制 HH:mm" });
const title = Type.String({ minLength: 1, maxLength: 80, description: "任务名称，1–80 个字符" });
const prompt = Type.String({ minLength: 1, maxLength: 8000, description: "到点后在独立后台会话执行的完整指令，包含必要目标、背景和输出要求；不能依赖当前聊天上下文，不复制整段聊天" });
const weekday = Type.Optional(Type.Integer({ minimum: 1, maximum: 7,
  description: "周几，1 为周一，7 为周日；weekly 时提供 weekday 或 weekdays" }));
const weekdays = Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), {
  minItems: 1, maxItems: 7, uniqueItems: true, description: "独立重复星期，七天等同每天" }));
const vibrate = Type.Optional(Type.Boolean({ description: "成功发起时短振动，无声音" }));
const deleteAfterRun = Type.Optional(Type.Boolean({ description: "成功发起后删除定义，保留执行会话；失败不删除" }));
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
    description: "管理本机定时任务。仅在用户明确交代定时执行任务时 create，不因普通聊天或建议擅自创建；信息足够就执行，仅缺少必要时间或任务内容时询问。title 是简短备注；prompt 必须是可在独立后台会话直接执行的完整指令，包含必要目标、背景和输出要求，不依赖当前聊天上下文，不复制整段聊天。每次执行都有独立结果会话；来源由宿主绑定当前会话，不接受来源参数，编辑保留原来源；暂停或删除不停止已开始的执行、不删除结果会话。首版不支持 cron、循环轮询或条件停止，不用另一套聊天调度模拟。repeat 为 once、daily、weekly、monthly、statutoryWorkday（法定工作日，含调休补班）或 statutoryHoliday（法定节假日，全部休息日含普通周末和公告放假、不含补班）。所有规则都在下一个满足条件的自然日对应 time（HH:mm）执行，按设备时区计算；once 只执行一次，今天该时刻仍在未来则今天执行，否则明天执行，不支持指定其他日期或相对延时。已过期的一次性任务会暂停，setEnabled 为 true 时重新计算下一次未来自然时刻。list 返回宿主 now（epoch 毫秒）、localNow（带偏移 ISO 时间）和 timeZone，不用模型自行猜测当前时间。weekly 必须提供 weekday 或非空不重复的 weekdays（1 是周一，7 是周日）；monthly 必须提供 monthDay（1–31，当月没有该日则跳过，不顺延）；vibrate 和 deleteAfterRun 可选，默认 false。两个法定规则独立保存，不传 weekdays。目前仅支持大陆设备时区下中国大陆官方安排，内置2026年并后台在线更新当前年/次年已公布安排，有效缓存无网络也可用；其他时区或未知年份分别按周一至周五/周六日执行。返回 calendarNotice 时必须向用户说明退化原因和 calendarFallback，不要声称已成功查询官方安排；calendarCoverage 表示当前内置或缓存覆盖年份。weekly 的 weekdays 永远是固定星期，不能将旧周一至五或周六日任务升级成法定规则。查看用 list。修改、暂停、恢复或删除前必须先 list，并带上返回的 id 和 revision；update 只传要改的字段，未传字段保持原值，启用或暂停状态也保持。暂停/恢复用 setEnabled，enabled 为 false/true。revision 不匹配时重新 list，不自动重试写入；不要编造 id 或 revision，也不要改用户没有点名的任务。根据真实返回任务的 nextRunAt、timeZone 和 enabled 准确告知执行日期时刻及状态，不只回显提交的时间。exactAlarmGranted 为 false 或 schedulingError 非空时，任务只是已保存，系统闹钟未排上，不要保证到点执行；缺少闹钟权限时请用户到系统「闹钟与提醒」授权，其他错误如实说明。失败、取消或超时后先 list 确认实际状态，不要立刻重复提交。",
    parameters: Type.Union([
      Type.Object({ action: Type.Literal("list") }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("create"), title, prompt, repeat, time,
        weekday, weekdays, monthDay, vibrate, deleteAfterRun },
        { additionalProperties: false }),
      Type.Object({
        action: Type.Literal("update"), id, revision,
        title: Type.Optional(title), prompt: Type.Optional(prompt), repeat: Type.Optional(repeat),
        time: Type.Optional(time),
        weekday, weekdays, monthDay, vibrate, deleteAfterRun,
      }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("setEnabled"), id, revision,
        enabled: Type.Boolean({ description: "false 暂停，true 恢复；不影响已开始的执行" }) },
        { additionalProperties: false }),
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
