/** Public view model only. Never put run tokens, credentials or tool capabilities in here. */
export const SHAPES = Object.freeze(['pebble', 'squircle', 'drop', 'cloud', 'hex', 'pill', 'leaf', 'star']);
export const COLORS = Object.freeze({ orange: '#ed8656', green: '#83a789', blue: '#7599cc', violet: '#a494c9', rose: '#cd8995', gold: '#c6a36c' });
export const STATES = Object.freeze({ idle: '待命', thinking: '思考中', working: '工作中', sending: '正在发消息', waiting: '等待回复', needsUser: '等待你确认', sleeping: '已归档', error: '需要处理' });
export const DELIVERY = Object.freeze({ queued: '已排队', running: '处理中', completed: '已处理', error: '失败', failed: '失败', aborted: '已中止', interrupted: '已中断', cancelled: '已取消', rejected: '已拒绝', skipped: '已跳过' });
const idOK = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(x);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o ?? {}, k);
export function newMessageId() {
    if (typeof globalThis.crypto?.randomUUID === 'function')
        return globalThis.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const h = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function requireId(id) { if (!idOK(id))
    throw new Error('无效的会话或消息 ID'); return id; }
export function hashId(id) { let h = 0; for (const c of id)
    h = (Math.imul(h, 31) + c.codePointAt(0)) >>> 0; return h; }
export function persona(bot) {
    const h = hashId(requireId(bot.id));
    return { shape: SHAPES.includes(bot.avatar?.shape) ? bot.avatar.shape : SHAPES[h % SHAPES.length],
        color: own(COLORS, bot.avatar?.color) ? bot.avatar.color : Object.keys(COLORS)[(h >>> 3) % Object.keys(COLORS).length] };
}
export function stateOf(bot) {
    if (bot.archived)
        return 'sleeping';
    if (bot.needsUser)
        return 'needsUser';
    return own(STATES, bot.activity) ? bot.activity : 'idle';
}
export function pairKey(a, b) { requireId(a); requireId(b); if (a === b)
    throw new Error('不能把同一个 bot 当作协作双方'); return JSON.stringify([a, b].sort()); }
export function isPeer(m) { return m.source?.kind === 'bot' && m.source.sessionId !== m.toSessionId; }
export function visibleTo(m, id) { return m.toSessionId === id || (isPeer(m) && m.source.sessionId === id); }
export function peerOf(m, id) { if (!isPeer(m) || !visibleTo(m, id))
    return null; return m.toSessionId === id ? m.source.sessionId : m.toSessionId; }
export function senderLabel(m, bots) {
    if (m.source.kind === 'user')
        return '你';
    if (m.source.kind === 'routine')
        return `定时任务 · ${m.source.name}`;
    return bots.find(b => b.id === m.source.sessionId)?.name ?? m.source.name ?? '已删除的 bot';
}
export function validateSnapshot(value) {
    if (!value || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
        !Array.isArray(value.bots) || !Array.isArray(value.messages) || !Array.isArray(value.routines))
        throw new Error('机器人界面数据版本不受支持');
    // Explicit allowlist prevents accidentally retaining credentials/capabilities in the renderer.
    const ids = new Set();
    const bots = value.bots.map(b => {
        requireId(b.id);
        if (ids.has(b.id))
            throw new Error('重复的 bot ID');
        ids.add(b.id);
        if (typeof b.name !== 'string' || typeof b.rolePrompt !== 'string')
            throw new Error('角色信息无效');
        return { id: b.id, name: b.name, rolePrompt: b.rolePrompt, description: typeof b.description === 'string' ? b.description : '',
            revision: Number.isSafeInteger(b.revision) ? b.revision : 0, archived: !!b.archived, needsUser: !!b.needsUser,
            activity: own(STATES, b.activity) ? b.activity : 'idle', modelLabel: typeof b.modelLabel === 'string' ? b.modelLabel : '默认模型',
            running: !!b.running,
            piSelection: Object.fromEntries(['provider', 'model', 'thinkingLevel'].filter(key => typeof b.piSelection?.[key] === 'string').map(key => [key, b.piSelection[key]])),
            requestId: b.running && typeof b.requestId === 'string' ? b.requestId : null,
            askUser: b.running && typeof b.requestId === 'string' && b.askUser ? b.askUser : null,
            questionnairePending: !!b.questionnairePending,
            questionnaireError: typeof b.questionnaireError === 'string' ? b.questionnaireError : '',
            avatar: persona(b), unread: Number.isSafeInteger(b.unread) && b.unread > 0 ? b.unread : 0 };
    });
    const seen = new Set();
    const messages = value.messages.map(m => {
        requireId(m.id);
        requireId(m.toSessionId);
        if (seen.has(m.id))
            throw new Error('消息重复：宿主须按 messageId 去重');
        seen.add(m.id);
        if (typeof m.body !== 'string' || !Number.isFinite(m.createdAt))
            throw new Error('消息内容无效');
        const s = m.source;
        let source;
        if (s?.kind === 'user')
            source = { kind: 'user' };
        else if (s?.kind === 'bot' || s?.kind === 'assistant') {
            requireId(s.sessionId);
            if (typeof s.name !== 'string')
                throw new Error('消息缺少发送者');
            source = { kind: s.kind, sessionId: s.sessionId, name: s.name };
        }
        else if (s?.kind === 'routine') {
            requireId(s.routineId);
            if (typeof s.name !== 'string')
                throw new Error('任务来源无效');
            source = { kind: 'routine', routineId: s.routineId, name: s.name };
        }
        else
            throw new Error('未知消息来源；不能当作用户消息显示');
        if (source.kind === 'bot' && source.sessionId === m.toSessionId)
            throw new Error('无效的 bot 自我投递');
        if (source.kind === 'assistant' && source.sessionId !== m.toSessionId)
            throw new Error('普通助手回复不可冒充跨 bot 投递');
        if (m.chainId !== undefined)
            requireId(m.chainId);
        if (m.replyToMessageId !== undefined)
            requireId(m.replyToMessageId);
        return { id: m.id, toSessionId: m.toSessionId, source, body: m.body, createdAt: m.createdAt,
            timeKnown: m.timeKnown !== false, status: own(DELIVERY, m.status) ? m.status : 'unknown', chainId: m.chainId, replyToMessageId: m.replyToMessageId };
    }).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const routines = value.routines.map(r => {
        requireId(r.id);
        requireId(r.ownerSessionId);
        if (typeof r.title !== 'string' || typeof r.prompt !== 'string' || !Number.isSafeInteger(r.revision))
            throw new Error('定时任务数据无效');
        return { id: r.id, ownerSessionId: r.ownerSessionId, title: r.title, prompt: r.prompt, revision: r.revision, enabled: !!r.enabled,
            repeat: ['daily', 'weekly', 'monthly'].includes(r.repeat) ? r.repeat : undefined, time: typeof r.time === 'string' ? r.time : undefined, weekday: r.weekday, monthDay: r.monthDay,
            scheduleLabel: typeof r.scheduleLabel === 'string' ? r.scheduleLabel : '计划由宿主提供', timeZone: typeof r.timeZone === 'string' ? r.timeZone : '',
            nextRunAt: Number.isFinite(r.nextRunAt) ? r.nextRunAt : null, lastStatus: own(DELIVERY, r.lastStatus) ? r.lastStatus : null };
    });
    return { version: 1, revision: value.revision, bots, messages, routines, notice: typeof value.notice === 'string' ? value.notice : '' };
}
export function pairMessages(snapshot, a, b, chainId) {
    const key = pairKey(a, b);
    return snapshot.messages.filter(m => isPeer(m) && pairKey(m.source.sessionId, m.toSessionId) === key && (!chainId || m.chainId === chainId));
}
export function collaborations(snapshot, id) {
    const map = new Map();
    for (const m of snapshot.messages) {
        const peer = peerOf(m, id);
        if (!peer)
            continue;
        const key = pairKey(id, peer);
        const row = map.get(key) ?? { key, peerId: peer, messages: [] };
        row.messages.push(m);
        map.set(key, row);
    }
    return [...map.values()].sort((a, b) => b.messages.at(-1).createdAt - a.messages.at(-1).createdAt);
}
export function conversationRows(snapshot, id) {
    const rows = [];
    for (const m of snapshot.messages.filter(m => visibleTo(m, id))) {
        const peer = peerOf(m, id), last = rows.at(-1);
        if (peer) {
            if (last?.kind === 'peer' && last.peerId === peer && last.chainId === m.chainId)
                last.messages.push(m);
            else
                rows.push({ kind: 'peer', id: m.id, peerId: peer, chainId: m.chainId, messages: [m] });
        }
        else
            rows.push({ kind: 'message', id: m.id, message: m });
    }
    return rows;
}
/** Status transitions never imply a peer replied: only explicit message records do. */
export function deliveryLabel(m) { return DELIVERY[m.status] ?? '状态未知'; }
export function timeLabel(ms) { return Number.isFinite(ms) ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(ms) : '—'; }
export function threadSource(m) { return m.source.kind === 'bot' ? 'BOT 来信' : m.source.kind === 'routine' ? '定时触发' : m.source.kind === 'user' ? '用户' : '助手'; }
