import { newMessageId } from '../../src/bots/model.mjs';
/** Browser-only interaction fixture. No model calls, scheduling, native permissions or disk writes. */
export function previewSnapshot() {
    const base = Date.now() - 35 * 60000;
    const bots = [
        { id: 'jarvis', name: '贾维斯', description: '把想法变成行动', rolePrompt: '你是我的日常助手。先理解目标，再联系合适的伙伴协作。重要结果简洁汇总，遇到需要我决策的事情先问我。', activity: 'idle', avatar: { shape: 'pebble', color: 'orange' }, modelLabel: '沿用会话模型' },
        { id: 'research', name: '研究员', description: '顺着好奇，找到答案', rolePrompt: '研究项目与技术问题。区分事实和推测，保留来源。收到其他 bot 的问题时，通过消息工具回复对方。', activity: 'thinking', avatar: { shape: 'squircle', color: 'green' }, modelLabel: '沿用会话模型' },
        { id: 'craft', name: '工程师', description: '让好主意真的跑起来', rolePrompt: '负责实现、验证与回归测试。优先保持实现简单，不把未运行的测试说成通过。', activity: 'working', avatar: { shape: 'drop', color: 'blue' }, modelLabel: '沿用会话模型' },
        { id: 'reading', name: '读书伙伴', description: '慢慢读，认真想', rolePrompt: '陪我精读书籍，解释困难的段落。', activity: 'waiting', avatar: { shape: 'cloud', color: 'violet' }, modelLabel: '沿用会话模型' },
        { id: 'archive-one', name: '旧项目助手', description: '项目已经告一段落', rolePrompt: '已归档的项目记录。', activity: 'idle', archived: true, avatar: { shape: 'leaf', color: 'gold' }, modelLabel: '沿用会话模型' }
    ].map(b => ({ ...b, revision: 1, unread: 0 }));
    const messages = [
        { id: 'm-user', toSessionId: 'jarvis', source: { kind: 'user' }, body: '帮我看看 e-launcher 的多 bot 协作怎么做。和研究员对齐一下，重点是消息来源和 UI。', chainId: 'c-research' },
        { id: 'm-answer', toSessionId: 'jarvis', source: { kind: 'assistant', sessionId: 'jarvis', name: '贾维斯' }, body: '我会让研究员先梳理消息来源，再请工程师检查接入方式。\n你可以在下面展开查看我们之间的往来。' },
        { id: 'm-to-research', toSessionId: 'research', source: { kind: 'bot', sessionId: 'jarvis', name: '贾维斯' }, body: '请检查 bot 来信与用户消息的区分方式，给我一份能直接用于 UI 的建议。', chainId: 'c-research' },
        { id: 'm-from-research', toSessionId: 'jarvis', source: { kind: 'bot', sessionId: 'research', name: '研究员' }, body: '用宿主提供的来源类型和 session ID 区分，名称只用于展示。主会话展示协作卡片，展开后显示双方消息、发送方向和回复关联。', chainId: 'c-research', replyToMessageId: 'm-to-research' },
        { id: 'm-to-craft', toSessionId: 'craft', source: { kind: 'bot', sessionId: 'jarvis', name: '贾维斯' }, body: '请按这份方案检查组件边界。不要把研究员与用户的私人聊天混进协作面板。', chainId: 'c-ui' },
        { id: 'm-from-craft', toSessionId: 'jarvis', source: { kind: 'bot', sessionId: 'craft', name: '工程师' }, body: '已经拆成头像、协作卡片和只读往来面板。会用稳定的消息 ID 去重，不根据正文推测来源。', chainId: 'c-ui', replyToMessageId: 'm-to-craft' },
        { id: 'm-result', toSessionId: 'jarvis', source: { kind: 'assistant', sessionId: 'jarvis', name: '贾维斯' }, body: '方向对齐了：每位 bot 保留自己的上下文，协作过程可以随时展开。\n头像也会有自己的形状和小动作，而不是一个冷冰冰的字母。' },
        { id: 'm-routine', toSessionId: 'jarvis', source: { kind: 'routine', routineId: 'r-morning', name: '每日项目简报' }, body: '汇总今天项目的进展和仍需我决定的事情。', chainId: 'c-routine' },
        { id: 'm-private', toSessionId: 'research', source: { kind: 'user' }, body: '这是一条只属于研究员与用户的私人消息，不应出现在 bot 间往来面板。' },
        { id: 'm-third', toSessionId: 'research', source: { kind: 'bot', sessionId: 'craft', name: '工程师' }, body: '这条消息只属于工程师与研究员。', chainId: 'c-third' }
    ].map((m, i) => ({ ...m, createdAt: base + i * 60000, status: m.id === 'm-routine' ? 'queued' : 'completed' }));
    return { version: 1, revision: 1, bots, messages, routines: [
            { id: 'r-morning', ownerSessionId: 'jarvis', title: '每日项目简报', prompt: '汇总今天项目的进展和仍需我决定的事情。', revision: 1, enabled: true, schedule: { kind: 'daily', hour: 8, minute: 30, timeZone: 'Europe/Amsterdam' }, scheduleLabel: '每天 08:30', timeZone: 'Europe/Amsterdam', nextRunAt: null },
            { id: 'r-week', ownerSessionId: 'research', title: '每周技术观察', prompt: '查找值得关注的新工具与论文，把结论发给贾维斯。', revision: 1, enabled: true, schedule: { kind: 'weekly', hour: 9, minute: 0, weekdays: [1], timeZone: 'Europe/Amsterdam' }, scheduleLabel: '每周一 09:00', timeZone: 'Europe/Amsterdam', nextRunAt: null }
        ] };
}
export class PreviewAdapter {
    capabilities = Object.freeze({ send: true, stop: true, create: true, profile: true, routines: true, restore: true, archive: true, delete: true });
    constructor(snapshot = previewSnapshot()) { this.value = structuredClone(snapshot); this.listeners = new Set(); this.failNext = null; this.calls = []; this.submissions = new Map(); }
    async read() { return structuredClone(this.value); }
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    changed() { this.value.revision++; for (const fn of this.listeners)
        fn(); }
    before(action) { if (this.failNext) {
        const e = this.failNext;
        this.failNext = null;
        throw new Error(e);
    } this.calls.push(action); }
    bot(id) { const b = this.value.bots.find(b => b.id === id); if (!b)
        throw new Error('此 bot 已不存在'); return b; }
    routine(id, revision) { const r = this.value.routines.find(r => r.id === id); if (!r)
        throw new Error('任务不存在'); if (r.revision !== revision)
        throw new Error('任务已被修改，请重新打开'); return r; }
    async send(input) {
        this.before('send');
        this.bot(input.toSessionId);
        const prior = this.submissions.get(input.submissionId);
        if (prior) {
            if (JSON.stringify(prior) !== JSON.stringify(input))
                throw new Error('重复提交内容不同');
            return;
        }
        this.submissions.set(input.submissionId, structuredClone(input));
        this.value.messages.push({ id: newMessageId(), source: { kind: 'user' }, toSessionId: input.toSessionId, body: input.body, createdAt: Date.now(), status: 'queued' });
        this.changed();
    }
    async stop(id) { this.before('stop'); this.bot(id).activity = 'idle'; this.changed(); }
    async createBot(input) { this.before('create'); const id = newMessageId(); const { routines = [], ...profile } = structuredClone(input); this.value.bots.push({ ...profile, id, activity: 'idle', revision: 1, unread: 0, modelLabel: '默认模型' }); for (const r of routines) {
        const s = r.schedule;
        this.value.routines.push({ ...r, id: newMessageId(), ownerSessionId: id, revision: 1, ...routineFields(s), nextRunAt: null });
    } this.changed(); return { id }; }
    async updateBot(input) { this.before('profile'); const b = this.bot(input.id); if (b.revision !== input.revision)
        throw new Error('角色已被修改，请重新打开'); Object.assign(b, structuredClone(input), { revision: b.revision + 1 }); this.changed(); }
    async archive(id) { this.before('archive'); const b = this.bot(id); b.archived = true; b.revision++; this.changed(); }
    async restore(id) { this.before('restore'); const b = this.bot(id); b.archived = false; b.revision++; this.changed(); }
    async deleteBot({ id, revision }) { this.before('delete'); if (this.bot(id).revision !== revision)
        throw new Error('角色已被修改'); this.value.bots = this.value.bots.filter(b => b.id !== id); this.value.routines = this.value.routines.filter(r => r.ownerSessionId !== id); this.value.messages = this.value.messages.filter(m => m.toSessionId !== id); this.changed(); }
    async setRoutineEnabled({ id, revision, enabled }) { this.before('routine.toggle'); const r = this.routine(id, revision); r.enabled = enabled; r.revision++; this.changed(); }
    async saveRoutine(input) {
        this.before('routine.save');
        this.bot(input.ownerSessionId);
        if (input.id) {
            const r = this.routine(input.id, input.revision);
            r.title = input.title;
            r.prompt = input.prompt;
            if (input.schedule) Object.assign(r, {schedule: structuredClone(input.schedule)}, routineFields(input.schedule));
            r.revision++;
        }
        else {
            const s = input.schedule;
            this.value.routines.push({ ...structuredClone(input), id: newMessageId(), revision: 1, enabled: true, ...routineFields(s), nextRunAt: null });
        }
        this.changed();
    }
    async runRoutine({ id, revision }) { this.before('routine.run'); const r = this.routine(id, revision); this.value.messages.push({ id: newMessageId(), source: { kind: 'routine', routineId: r.id, name: r.title }, toSessionId: r.ownerSessionId, body: r.prompt, createdAt: Date.now(), status: 'queued' }); this.changed(); }
}

function routineFields(s) {
    const time = `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`;
    const label = s.kind === 'weekly' ? `每周${s.weekday}` : s.kind === 'monthly' ? `每月 ${s.monthDay} 日` : '每天';
    return {repeat: s.kind, time, weekday: s.weekday ?? 1, monthDay: s.monthDay ?? 1,
        timeZone: s.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, scheduleLabel: `${label} ${time}`};
}
