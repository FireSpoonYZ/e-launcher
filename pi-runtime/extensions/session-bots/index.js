import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { ACTIONS, validateCall, roleInstruction } from './protocol.js';

const schedule = Type.Object({
  id: Type.Optional(Type.String()), revision: Type.Optional(Type.Integer({ minimum: 1 })),
  title: Type.String({ minLength: 1, maxLength: 80 }), prompt: Type.String({ minLength: 1, maxLength: 8000 }),
  repeat: Type.Union([Type.Literal('daily'), Type.Literal('weekly'), Type.Literal('monthly')]),
  time: Type.String({ pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' }),
  weekday: Type.Optional(Type.Integer({ minimum: 1, maximum: 7 })),
  monthDay: Type.Optional(Type.Integer({ minimum: 1, maximum: 31 })),
}, { additionalProperties: false });

export default function sessionBots(pi, { request, profile }) {
  // A fresh immutable host snapshot is supplied for each turn. An edit takes effect next turn.
  pi.on('before_agent_start', event => roleInstruction(event, profile));
  pi.registerTool(defineTool({
    name: 'bots', label: 'Bots and routines',
    description: '创建/查找 bot、异步发消息、查看或修改自己的角色说明及定时任务。先 list 取得真实 ID。'
      + 'send 立即返回投递编号，目标忙时排队；最终输出不会自动转发。回复来信请使用 reply + messageId + message。不要轮询等待或无限互相回信。'
      + 'create 可同时设置初始角色说明和 schedules，不复制历史。每个定时任务在所属 bot 原会话中运行。'
      + 'self 返回角色 revision；role 修改需要当前 revision。schedules 返回任务 revision，修改/启停/删除需匹配。'
      + 'schedule_save 保存不立即执行，schedule_run 才会真实执行。不能修改他人的配置，不能删除 bot。',
    parameters: Type.Object({
      action: Type.Union(ACTIONS.map(action => Type.Literal(action))),
      query: Type.Optional(Type.String({ maxLength: 128 })),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
      rolePrompt: Type.Optional(Type.String({ maxLength: 16000 })),
      targetId: Type.Optional(Type.String()), message: Type.Optional(Type.String({ minLength: 1, maxLength: 16000 })),
      expectsReply: Type.Optional(Type.Boolean()), messageId: Type.Optional(Type.String()),
      revision: Type.Optional(Type.Integer({ minimum: 0 })),
      schedules: Type.Optional(Type.Array(schedule, { maxItems: 10 })),
      schedule: Type.Optional(schedule), taskId: Type.Optional(Type.String()), enabled: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    async execute(toolCallId, args, signal) {
      signal?.throwIfAborted(); validateCall(args);
      const result = await request(args, signal, toolCallId);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  }));
}
