import { newMessageId, STATES, SHAPES, COLORS, validateSnapshot, persona, stateOf, pairMessages, collaborations, conversationRows, senderLabel, deliveryLabel, timeLabel, threadSource } from './model.mjs';
import { el, button, textButton, icon, labelledInput } from './dom.mjs';
import { createAvatar, observeAvatars } from './avatar.mjs';
const EMPTY = { version: 1, revision: 0, bots: [], messages: [], routines: [] };
const SHAPE_LABELS = ['卵石', '方糖', '水滴', '云朵', '六角', '胶囊', '叶子', '星星'];
const COLOR_LABELS = ['杏橙', '鼠尾草', '雾蓝', '丁香', '玫瑰', '麦金'];
const byId = (v, id) => v.bots.find(b => b.id === id);
function iconButton(name, label, action, cls) { const b = button(label, action, cls); b.append(icon(name)); return b; }
function identity(bot, size = 42) { const group = el('span', 'eb-identity'); group.append(createAvatar(bot, { size }), el('span', 'eb-identity-name', bot.name)); return group; }
function fallbackBot(id, name = '已删除的 bot') { return { id, name, rolePrompt: '', activity: 'idle', archived: true }; }
function statusLabel(bot) { const s = stateOf(bot), span = el('span', 'eb-status', STATES[s]); span.dataset.state = s; return span; }
function badge(t) { return el('span', 'eb-badge', t); }
/** Actual UI. The same renderer is used by the demo and by the React route; no fake native fallback. */
export class BotWorkspace {
    constructor(root, adapter, { initialSessionId, onExit, onOpenChat, preview = false } = {}) {
        this.root = root;
        this.adapter = adapter;
        this.options = { onExit, onOpenChat, preview };
        this.current = initialSessionId;
        this.view = EMPTY;
        this.tab = 'chat';
        this.dead = false;
        this.drafts = new Map();
        this.shown = 120;
        this.busy = new Set();
        this.generation = 0;
        this.followLatest = true;
        this.newCount = 0;
        this.paused = false;
        this.loading = true;
        this.lastRevision = -1;
        this.dialog = null;
        root.classList.add('eb-root');
        root.dataset.preview = String(preview);
        this.notice = el('div', 'eb-notice');
        this.notice.setAttribute('role', 'status');
        if (preview)
            this.notice.textContent = '交互预览 · 示例数据，未连接模型或系统闹钟';
        else
            this.notice.hidden = true;
        this.layout = el('div', 'eb-layout');
        this.sidebar = el('aside', 'eb-sidebar');
        this.sidebar.setAttribute('aria-label', '机器人列表');
        this.main = el('main', 'eb-main');
        this.header = el('header', 'eb-header');
        this.tabs = el('nav', 'eb-tabs');
        this.tabs.setAttribute('aria-label', '会话视图');
        this.content = el('section', 'eb-content');
        this.content.tabIndex = 0;
        this.content.setAttribute('aria-label', '会话内容');
        this.content.addEventListener('scroll', () => { this.followLatest = this.content.scrollHeight - this.content.scrollTop - this.content.clientHeight < 64; }, { passive: true });
        this.composer = el('form', 'eb-composer');
        this.jump = textButton('查看新消息', () => { this.followLatest = true; this.newCount = 0; this.content.scrollTop = this.content.scrollHeight; this.jump.hidden = true; }, 'eb-jump');
        this.jump.hidden = true;
        this.input = el('textarea');
        this.input.rows = 1;
        this.input.maxLength = 8000;
        this.input.placeholder = '给机器人发消息…';
        this.input.setAttribute('aria-label', '给当前 bot 发送用户消息');
        this.input.addEventListener('input', () => { this.drafts.set(this.current, this.input.value); this.sendButton.disabled = !this.input.value.trim() || this.busy.has('send'); });
        this.input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
            e.preventDefault();
            this.composer.requestSubmit();
        } });
        this.sendButton = iconButton('send', '发送用户消息', null, 'eb-send');
        this.sendButton.type = 'submit';
        this.sendButton.disabled = true;
        this.stopButton = textButton('停止', () => this.confirmStop(byId(this.view, this.current)), 'eb-stop');
        this.composerHint = el('div', 'eb-composer-hint', '以你的身份发送 · Ctrl / ⌘ + Enter');
        const box = el('div', 'eb-compose-box');
        box.append(this.input, this.stopButton, this.sendButton);
        this.composer.append(box, this.composerHint);
        this.composer.addEventListener('submit', e => { e.preventDefault(); void this.sendUser(); });
        this.main.append(this.header, this.tabs, this.content, this.jump, this.composer);
        this.detail = el('aside', 'eb-detail');
        this.detail.setAttribute('aria-label', '机器人详情');
        this.layout.append(this.sidebar, this.main, this.detail);
        this.live = el('div', 'eb-sr-only');
        this.live.setAttribute('aria-live', 'polite');
        root.replaceChildren(this.notice, this.layout, this.live);
        this.motion = observeAvatars(root);
        this.backListener = e => { if (this.dialog) {
            e.preventDefault();
            this.closeDialog();
        } };
        window.addEventListener('app-back', this.backListener);
        this.keyListener = e => { if (e.key === 'Escape' && this.dialog) {
            e.preventDefault();
            e.stopPropagation();
            this.closeDialog();
        } };
        document.addEventListener('keydown', this.keyListener, true);
        // Subscribe before read. Skip older revisions after the listener/snapshot race.
        Promise.resolve().then(() => adapter.subscribe?.(() => void this.refresh())).then(unsubscribe => {
            if (this.dead)
                unsubscribe?.();
            else {
                this.unsubscribe = unsubscribe;
                void this.refresh();
            }
        }).catch(e => { if (!this.dead) {
            this.loading = false;
            this.failure = e;
            this.render();
        } });
        this.render();
    }
    async refresh() {
        const ticket = ++this.generation;
        try {
            const v = validateSnapshot(await this.adapter.read());
            if (this.dead || ticket !== this.generation || v.revision < this.lastRevision)
                return;
            const oldCount = this.view.messages.length;
            this.view = v;
            this.lastRevision = v.revision;
            if (!byId(v, this.current))
                this.current = v.bots.find(b => !b.archived)?.id ?? v.bots[0]?.id;
            this.loading = false;
            this.failure = null;
            this.notice.hidden = !v.notice && !this.options.preview;
            this.notice.dataset.error = 'false';
            this.notice.textContent = v.notice || (this.options.preview ? '交互预览 · 示例数据，未连接模型或系统闹钟' : '');
            this.render();
            if (v.messages.length > oldCount && oldCount) {
                this.live.textContent = '会话有新内容';
            }
        }
        catch (e) {
            if (!this.dead && ticket === this.generation) {
                this.loading = false;
                this.failure = e;
                this.render();
            }
        }
    }
    error(e) { if (this.dead)
        return; this.live.textContent = `操作失败：${e?.message ?? String(e)}`; this.notice.hidden = false; this.notice.dataset.error = 'true'; this.notice.textContent = this.live.textContent; }
    async perform(key, fn) { if (this.busy.has(key) || this.dead)
        return false; this.busy.add(key); try {
        await fn();
        if (!this.dead)
            await this.refresh();
        return true;
    }
    catch (e) {
        this.error(e);
        return false;
    }
    finally {
        this.busy.delete(key);
    } }
    cap(name) { return !!this.adapter.capabilities?.[name]; }
    async sendUser() {
        const to = this.current, body = this.input.value;
        if (!to || !body.trim() || !this.cap('send') || this.busy.has('send'))
            return;
        this.sendButton.disabled = true;
        const requestId = newMessageId();
        const ok = await this.perform('send', () => this.adapter.send({ toSessionId: to, body, submissionId: requestId }));
        if (ok && this.drafts.get(to) === body) {
            this.drafts.set(to, '');
            if (this.current === to)
                this.input.value = '';
        }
        if (this.options.preview && ok) {
            this.live.textContent = '已加入演示队列，没有调用模型';
            this.composerHint.textContent = '已加入演示队列，没有调用模型';
        }
        this.sendButton.disabled = this.input.disabled || !this.input.value.trim();
    }
    select(id) { if (id === this.current) {
        this.closeDialog();
        return;
    } this.current = id; this.shown = 120; this.followLatest = true; this.tab = 'chat'; this.closeDialog(); this.render(); this.content.scrollTop = this.content.scrollHeight; }
    setTab(tab) { this.tab = tab; this.followLatest = true; this.render(); this.content.scrollTop = tab === 'chat' ? this.content.scrollHeight : 0; }
    render() {
        if (this.dead)
            return;
        const bot = byId(this.view, this.current);
        const top = this.content.scrollTop;
        const active = document.activeElement;
        const focusKey = active?.getAttribute?.('data-focus-key');
        this.renderRoster(this.sidebar);
        this.header.replaceChildren();
        this.tabs.replaceChildren();
        this.detail.replaceChildren();
        if (this.failure) {
            this.content.replaceChildren(this.empty('暂时无法连接机器人服务', this.failure.message ?? String(this.failure), () => this.refresh(), '重试'));
            this.header.append(iconButton('back', '返回原界面', () => this.options.onExit?.()), el('h1', '', '机器人'));
            this.composer.hidden = true;
            return;
        }
        if (this.loading && !bot) {
            this.content.replaceChildren(this.empty('正在读取机器人…', '正在连接会话服务。'));
            this.composer.hidden = true;
            return;
        }
        if (!bot) {
            this.content.replaceChildren(this.empty('给一件事，一个专属助手。', '创建你的第一个 bot，给它角色说明，再交给它任务。', () => this.editBot(null), '创建机器人'));
            this.header.append(iconButton('back', '返回原界面', () => this.options.onExit?.()), el('h1', '', '机器人'));
            this.composer.hidden = true;
            return;
        }
        this.header.append(iconButton('menu', '打开机器人列表', () => this.openRoster(), 'eb-icon-button eb-mobile-menu'));
        const title = button('编辑当前 bot 的头像和角色', () => this.editBot(bot), 'eb-header-title');
        title.append(createAvatar(bot, { size: 42 }));
        const text = el('span');
        text.append(el('strong', '', bot.name), statusLabel(bot));
        title.append(text);
        this.header.append(title);
        const full = iconButton('chat', '打开原生完整聊天', () => this.perform('openChat', () => this.options.onOpenChat?.(bot.id)));
        full.disabled = !this.options.onOpenChat;
        this.header.append(full);
        this.header.append(iconButton('more', '机器人详情', () => this.editBot(bot)));
        for (const [key, label, symbol] of [['chat', '对话', 'chat'], ['collab', '协作', 'link'], ['routines', '定时任务', 'clock']]) {
            const b = button(label, () => this.setTab(key), 'eb-tab');
            b.dataset.active = String(this.tab === key);
            b.setAttribute('aria-current', this.tab === key ? 'page' : 'false');
            b.setAttribute('data-focus-key', `tab-${key}`);
            b.append(icon(symbol), el('span', '', label));
            this.tabs.append(b);
        }
        this.renderDetail(bot);
        this.content.replaceChildren();
        if (this.tab === 'chat')
            this.renderChat(bot);
        else if (this.tab === 'collab')
            this.renderCollaborations(bot);
        else
            this.renderRoutines(bot);
        this.composer.hidden = this.tab !== 'chat';
        this.composerHint.textContent = this.options.preview ? '以用户身份加入演示队列 · 不调用模型' : `${bot.modelLabel} · 以你的身份发送`;
        this.input.value = this.drafts.get(this.current) ?? '';
        this.input.placeholder = `给 ${bot.name} 发消息…`;
        this.input.disabled = bot.archived || !this.cap('send');
        this.sendButton.disabled = this.input.disabled || !this.input.value.trim() || this.busy.has('send');
        this.stopButton.hidden = !['thinking', 'working', 'sending', 'waiting', 'needsUser'].includes(stateOf(bot)) || !this.cap('stop');
        const near = this.followLatest;
        this.content.scrollTop = near && this.tab === 'chat' ? this.content.scrollHeight : top;
        this.jump.hidden = near || this.tab !== 'chat';
        if (focusKey)
            [...this.root.querySelectorAll('[data-focus-key]')].find(n => n.getAttribute('data-focus-key') === focusKey)?.focus({ preventScroll: true });
        this.dialog?.refresh?.();
        this.motion.refresh();
    }
    renderRoster(target) {
        target.replaceChildren();
        const brand = el('div', 'eb-brand');
        brand.append(el('span', 'eb-wordmark', 'e-launcher'), badge('BOTS'));
        if (this.options.onExit)
            brand.append(iconButton('back', '回到聊天', () => { this.closeDialog(); this.options.onExit(); }));
        target.append(brand);
        const head = el('div', 'eb-section-heading');
        head.append(el('h2', '', '我的机器人'), iconButton('plus', '创建机器人', () => this.editBot(null)));
        target.append(head);
        const list = el('div', 'eb-roster-list');
        for (const b of this.view.bots) {
            if (b.archived)
                continue;
            const row = button(`打开 ${b.name}`, () => this.select(b.id), 'eb-roster-row');
            row.dataset.selected = String(b.id === this.current);
            row.dataset.sessionId = b.id;
            row.append(createAvatar(b, { size: 48 }));
            const info = el('span', 'eb-roster-text');
            info.append(el('strong', '', b.name), el('small', '', b.description || STATES[stateOf(b)]));
            row.append(info);
            if (b.unread)
                row.append(el('span', 'eb-unread', b.unread > 99 ? '99+' : b.unread));
            else
                row.append(statusLabel(b));
            list.append(row);
        }
        target.append(list);
        const arch = this.view.bots.filter(b => b.archived);
        if (arch.length) {
            const d = el('details', 'eb-archives');
            d.append(el('summary', '', `已归档 · ${arch.length}`));
            for (const b of arch)
                d.append(textButton(b.name, () => this.select(b.id), 'eb-archive-row'));
            target.append(d);
        }
        const foot = el('div', 'eb-roster-footer');
        const motion = textButton(this.paused ? '开启动画' : '减少动画', () => { this.paused = !this.paused; this.root.dataset.userPaused = String(this.paused); this.render(); }, 'eb-quiet');
        motion.prepend(icon(this.paused ? 'play' : 'pause'));
        motion.setAttribute('aria-pressed', String(this.paused));
        foot.append(motion);
        if (this.options.preview)
            foot.append(textButton('切换明暗', () => { this.root.dataset.theme = this.root.dataset.theme === 'dark' ? 'light' : 'dark'; }, 'eb-quiet'));
        foot.append(el('span', 'eb-footnote', '一个会话，一位长期助手。'));
        target.append(foot);
    }
    renderDetail(bot) {
        const portrait = button('编辑头像', () => this.editBot(bot), 'eb-portrait');
        portrait.append(createAvatar(bot, { size: 106 }));
        this.detail.append(portrait, el('h2', '', bot.name), statusLabel(bot), el('p', 'eb-description', bot.description || '你的专属助手'));
        const role = el('section', 'eb-detail-section');
        role.append(el('h3', '', '角色说明'), el('p', '', bot.rolePrompt || '尚未设置角色说明。'));
        this.detail.append(role);
        const links = collaborations(this.view, bot.id), row = el('section', 'eb-detail-section');
        row.append(el('h3', '', '协作伙伴'));
        if (!links.length)
            row.append(el('p', 'eb-muted', '还没有 bot 间对话。'));
        for (const p of links.slice(0, 3)) {
            const peer = byId(this.view, p.peerId) ?? fallbackBot(p.peerId);
            const b = button(`查看与 ${peer.name} 的对话`, () => this.openPair(bot.id, peer.id), 'eb-detail-peer');
            b.append(identity(peer, 32), el('small', '', `${p.messages.length} 条`), icon('chevron'));
            row.append(b);
        }
        this.detail.append(row);
        const r = this.view.routines.filter(r => r.ownerSessionId === bot.id), routine = el('section', 'eb-detail-section');
        routine.append(el('h3', '', '例行安排'));
        if (r.length)
            routine.append(el('p', '', r[0].title), el('small', 'eb-muted', `${r[0].scheduleLabel} · ${r[0].timeZone}`));
        else
            routine.append(el('p', 'eb-muted', '没有定时任务'));
        routine.append(textButton('管理定时任务', () => this.setTab('routines'), 'eb-text-link'));
        this.detail.append(routine);
    }
    empty(title, description, action, label) { const n = el('div', 'eb-empty'); n.append(createAvatar({ id: 'empty', name: '小助手', activity: 'idle', avatar: { shape: 'pebble', color: 'orange' } }, { size: 90 }), el('h2', '', title), el('p', '', description)); if (action)
        n.append(textButton(label, action)); return n; }
    renderChat(bot) {
        const rows = conversationRows(this.view, bot.id);
        const intro = el('div', 'eb-chat-intro');
        intro.append(el('span', 'eb-eyebrow', 'YOUR EVERYDAY TEAM'), el('h2', '', `和 ${bot.name} 一起，把事情做好。`), el('p', '', '用户对话、协作来信和定时任务，留在同一个上下文里。'));
        this.content.append(intro);
        if (bot.archived) {
            const banner = el('div', 'eb-inline-note', '此 bot 已归档，自动触发已暂停。');
            if (this.cap('restore'))
                banner.append(textButton('恢复', () => this.perform('restore', () => this.adapter.restore(bot.id)), 'eb-text-link'));
            this.content.append(banner);
        }
        if (rows.length > this.shown)
            this.content.append(textButton('加载更早的消息', () => { this.shown += 120; this.followLatest = false; this.render(); }, 'eb-load-older'));
        const log = el('div', 'eb-transcript');
        log.setAttribute('role', 'log');
        log.setAttribute('aria-live', 'off');
        for (const row of rows.slice(-this.shown)) {
            if (row.kind === 'message')
                log.append(this.message(row.message, bot.id));
            else
                log.append(this.peerCard(row, bot));
        }
        this.content.append(log);
    }
    message(m, viewer, { pair = false } = {}) {
        const n = el('article', 'eb-message');
        n.dataset.source = m.source.kind;
        n.dataset.messageId = m.id;
        n.dataset.direction = m.source.kind === 'user' ? 'user' : pair && m.source.sessionId === viewer ? 'outgoing' : 'incoming';
        const header = el('div', 'eb-message-head');
        if (m.source.kind === 'bot' || m.source.kind === 'assistant') {
            const b = byId(this.view, m.source.sessionId) ?? fallbackBot(m.source.sessionId, m.source.name);
            header.append(createAvatar(b, { size: 27, staticPose: true }));
        }
        if (m.source.kind === 'routine')
            header.append(icon('clock'));
        header.append(el('strong', '', senderLabel(m, this.view.bots)), badge(pair && m.source.kind === 'bot' ? 'BOT 消息' : threadSource(m)), el('time', '', m.timeKnown ? timeLabel(m.createdAt) : '历史记录'));
        n.append(header);
        if (pair) {
            const to = byId(this.view, m.toSessionId);
            n.append(el('div', 'eb-routing', `${m.source.sessionId} → ${m.toSessionId}${to ? ' · 发给 ' + to.name : ''}`));
        }
        if (m.replyToMessageId) {
            const parent = this.view.messages.find(p => p.id === m.replyToMessageId);
            if (parent && pair && isReplyVisible(parent, m)) {
                const reply = textButton(`回复：${parent.body.slice(0, 70)}`, () => { const scope = n.closest('dialog') ?? this.content; [...scope.querySelectorAll('[data-message-id]')].find(e => e.dataset.messageId === parent.id)?.scrollIntoView({ block: 'center', behavior: 'auto' }); }, 'eb-reply');
                n.append(reply);
            }
        }
        n.append(el('div', 'eb-message-body', m.body));
        if (m.source.kind !== 'assistant') {
            const status = el('small', 'eb-delivery', deliveryLabel(m));
            status.dataset.status = m.status;
            n.append(status);
        }
        return n;
    }
    peerCard(row, bot) {
        const peer = byId(this.view, row.peerId) ?? fallbackBot(row.peerId);
        const wrap = el('div', 'eb-peer-card');
        const open = button(`查看 ${bot.name} 与 ${peer.name} 的 ${row.messages.length} 条协作消息`, () => this.openPair(bot.id, peer.id, row.chainId), 'eb-peer-open');
        const faces = el('span', 'eb-peer-avatars');
        faces.append(createAvatar(bot, { size: 31, staticPose: true }), createAvatar(peer, { size: 31, staticPose: true }));
        open.dataset.focusKey = `peer-${row.id}`;
        const text = el('span', 'eb-peer-caption');
        text.append(el('strong', '', `${bot.name} ↔ ${peer.name}`), el('small', '', `${row.messages.length} 条协作消息 · ${timeLabel(row.messages.at(-1).createdAt)}`));
        open.append(faces, text, icon('chevron'));
        wrap.append(open);
        const preview = el('div', 'eb-peer-preview');
        for (const m of row.messages.slice(-2)) {
            const line = el('p');
            line.append(el('strong', '', `${senderLabel(m, this.view.bots)}  `), el('span', '', m.body));
            preview.append(line);
        }
        wrap.append(preview);
        const caption = el('div', 'eb-peer-footer');
        caption.append(badge('BOT 间对话'), el('span', '', deliveryLabel(row.messages.at(-1))));
        wrap.append(caption);
        return wrap;
    }
    renderCollaborations(bot) {
        const head = el('div', 'eb-view-heading');
        head.append(el('span', 'eb-eyebrow', 'WORKING TOGETHER'), el('h2', '', '让协作看得见。'), el('p', '', '只展示实际交换的消息，不混入对方与用户的私人对话。'));
        this.content.append(head);
        const pairs = collaborations(this.view, bot.id);
        if (!pairs.length) {
            this.content.append(this.empty('还没有协作记录', '让这个 bot 联系另一位助手，来往消息就会出现在这里。'));
            return;
        }
        for (const p of pairs) {
            const peer = byId(this.view, p.peerId) ?? fallbackBot(p.peerId), card = button(`查看 ${peer.name} 的协作记录`, () => this.openPair(bot.id, p.peerId), 'eb-collaboration');
            const stage = el('div', 'eb-collab-stage');
            stage.append(identity(bot, 54));
            const rail = el('span', 'eb-rail');
            rail.setAttribute('aria-hidden', 'true');
            rail.dataset.active = String(p.messages.some(m => m.status === 'running'));
            rail.append(el('i'));
            stage.append(rail, identity(peer, 54));
            card.append(stage);
            card.append(el('p', '', p.messages.at(-1).body));
            const footer = el('div', 'eb-card-footer');
            footer.append(el('span', '', `${p.messages.length} 条消息`), el('span', '', `查看完整往来 ${'→'}`));
            card.append(footer);
            this.content.append(card);
        }
    }
    renderRoutines(bot) {
        const head = el('div', 'eb-view-heading');
        head.append(el('span', 'eb-eyebrow', 'A LITTLE ROUTINE'), el('h2', '', '按时开始，接着聊。'), el('p', '', '每个任务都回到这个 bot 的会话，不创建新的上下文。'));
        this.content.append(head);
        const create = textButton('＋ 添加定时任务', () => this.editRoutine(bot, null));
        create.disabled = !this.cap('routines') || bot.archived;
        this.content.append(create);
        for (const r of this.view.routines.filter(r => r.ownerSessionId === bot.id)) {
            const n = el('article', 'eb-routine');
            const top = el('div', 'eb-routine-head');
            top.append(icon('clock'), el('h3', '', r.title));
            const toggle = button(r.enabled ? '暂停定时任务' : '启用定时任务', async () => { toggle.disabled = true; await this.perform(r.id, () => this.adapter.setRoutineEnabled({ id: r.id, revision: r.revision, enabled: !r.enabled })); toggle.disabled = false; }, 'eb-switch');
            toggle.setAttribute('role', 'switch');
            toggle.setAttribute('aria-checked', String(r.enabled));
            toggle.disabled = !this.cap('routines') || bot.archived;
            toggle.append(el('span'));
            top.append(toggle);
            n.append(top, el('p', '', r.prompt), el('div', 'eb-routine-time', `${r.scheduleLabel} · ${r.timeZone}`));
            let info = '由 Android 调度器计算';
            try {
                if (r.nextRunAt)
                    info = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short', timeZone: r.timeZone || undefined }).format(r.nextRunAt);
            }
            catch {
                info = '时区无效，请检查任务计划';
            }
            n.append(el('small', 'eb-muted', r.enabled ? `下次运行：${info}` : '已暂停，不再自动触发'));
            const actions = el('div', 'eb-routine-actions');
            const edit = textButton('编辑', () => this.editRoutine(bot, r), 'eb-quiet');
            edit.disabled = !this.cap('routines');
            const run = textButton('立即运行', () => this.confirmRun(bot, r), 'eb-quiet');
            run.disabled = !this.cap('routines') || bot.archived;
            actions.append(edit, run);
            n.append(actions);
            this.content.append(n);
        }
    }
    openDialog(title, { wide = false } = {}) {
        this.closeDialog();
        const previous = document.activeElement;
        const d = el('dialog', `eb-dialog${wide ? ' eb-wide-dialog' : ''}`);
        d.setAttribute('role', 'dialog');
        d.setAttribute('aria-modal', 'true');
        d.setAttribute('aria-label', title);
        const head = el('header', 'eb-dialog-header');
        head.append(el('h2', '', title), iconButton('close', '关闭面板', () => this.closeDialog()));
        d.append(el('span', 'eb-sheet-handle'), head);
        const body = el('div', 'eb-dialog-body');
        d.append(body);
        d.addEventListener('cancel', e => { e.preventDefault(); this.closeDialog(); });
        d.addEventListener('click', e => { if (e.target === d) {
            const r = d.getBoundingClientRect();
            if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
                this.closeDialog();
        } });
        this.dialog = { element: d, previous, previousKey: previous?.dataset?.focusKey };
        this.root.dataset.overlay = 'true';
        this.root.append(d);
        d.showModal();
        this.motion.refresh();
        return { dialog: d, body };
    }
    closeDialog() { if (!this.dialog)
        return; const { element, previous, previousKey } = this.dialog; this.dialog = null; this.root.dataset.overlay = 'false'; element.close(); element.remove(); const focus = previous?.isConnected ? previous : previousKey ? [...this.root.querySelectorAll('[data-focus-key]')].find(n => n.dataset.focusKey === previousKey) : this.header.querySelector('button'); focus?.focus({ preventScroll: true }); this.motion.refresh(); }
    openRoster() { const { body } = this.openDialog('我的机器人'); this.renderRoster(body); this.dialog.refresh = () => this.renderRoster(body); this.motion.refresh(); }
    openPair(a, b, chainId) {
        const left = byId(this.view, a) ?? fallbackBot(a), right = byId(this.view, b) ?? fallbackBot(b);
        const { body } = this.openDialog(`${left.name} 与 ${right.name} 的对话`, { wide: true });
        const hero = el('div', 'eb-pair-hero');
        hero.append(identity(left, 60), el('span', 'eb-pair-arrow', '↔'), identity(right, 60));
        body.append(hero);
        const scope = el('div', 'eb-pair-scope');
        scope.append(badge('仅查看'), el('span', '', chainId ? '当前协作链' : '双方全部往来'));
        body.append(scope);
        const entries = el('div', 'eb-pair-log');
        entries.setAttribute('role', 'log');
        entries.setAttribute('aria-label', 'bot 间完整对话');
        let showAll = false;
        const fill = () => { const top = body.scrollTop; entries.replaceChildren(); for (const m of pairMessages(this.view, a, b, showAll ? undefined : chainId))
            entries.append(this.message(m, a, { pair: true })); body.scrollTop = top; };
        fill();
        body.append(entries);
        this.dialog.refresh = fill;
        if (chainId)
            body.append(textButton('查看这两个 bot 的全部往来', () => { showAll = true; fill(); scope.lastChild.textContent = '双方全部往来'; }, 'eb-text-link'));
        body.append(el('p', 'eb-privacy-note', '这里没有输入框。你不会因为查看对话而变成其中一个 bot，也不会唤醒它们。'));
        const actions = el('div', 'eb-dialog-actions');
        for (const bot of [left, right]) {
            const n = textButton(`打开 ${bot.name}`, () => this.select(bot.id), 'eb-button eb-secondary');
            n.disabled = !byId(this.view, bot.id);
            actions.append(n);
        }
        body.append(actions);
        this.motion.refresh();
    }
    editBot(bot) {
        const creating = !bot;
        const { body, dialog } = this.openDialog(creating ? '新建机器人' : '角色与外观');
        let avatar = bot ? persona(bot) : { shape: 'pebble', color: 'orange' };
        const display = el('div', 'eb-editor-portrait');
        const render = () => display.replaceChildren(createAvatar({ id: bot?.id ?? 'new-bot', name: bot?.name ?? '新助手', activity: 'idle', avatar }, { size: 106 }));
        render();
        body.append(display);
        const shapes = el('div', 'eb-shape-grid');
        SHAPES.forEach((shape, i) => { const b = button(SHAPE_LABELS[i], () => { avatar = { ...avatar, shape }; refreshOptions(); }, 'eb-shape-option'); b.dataset.shape = shape; b.append(createAvatar({ id: shape, name: SHAPE_LABELS[i], avatar: { color: avatar.color, shape } }, { size: 38, staticPose: true })); shapes.append(b); });
        const colors = el('div', 'eb-color-grid');
        Object.entries(COLORS).forEach(([name, value], i) => { const b = button(COLOR_LABELS[i], () => { avatar = { ...avatar, color: name }; refreshOptions(); }, 'eb-color-option'); b.dataset.color = name; b.style.setProperty('--swatch', value); colors.append(b); });
        const refreshOptions = () => { render(); for (const [i, b] of [...shapes.children].entries()) {
            b.setAttribute('aria-pressed', String(b.dataset.shape === avatar.shape));
            b.replaceChildren(createAvatar({ id: SHAPES[i], name: SHAPE_LABELS[i], avatar: { color: avatar.color, shape: SHAPES[i] } }, { size: 38, staticPose: true }));
        } for (const b of colors.children)
            b.setAttribute('aria-pressed', String(b.dataset.color === avatar.color)); this.motion.refresh(); };
        body.append(shapes, colors);
        refreshOptions();
        const name = labelledInput('名称', { value: bot?.name ?? '', placeholder: '给它一个好记的名字' });
        name.input.maxLength = 80;
        const description = labelledInput('一句话介绍', { value: bot?.description ?? '', placeholder: '例如：你的项目研究伙伴' });
        description.input.maxLength = 240;
        const role = labelledInput('角色说明', { value: bot?.rolePrompt ?? '', multiline: true, placeholder: '它负责什么，以及你希望它怎样工作。' });
        role.input.maxLength = 16000;
        role.input.rows = 5;
        body.append(name.wrap, description.wrap, role.wrap, el('p', 'eb-muted', '角色说明下一轮生效，不会覆盖全局规则或清空对话。'));
        let initialRoutine;
        if (creating) {
            const check = labelledInput('创建时添加一个定时任务', { type: 'checkbox' });
            check.input.checked = false;
            check.wrap.classList.add('eb-checkbox-field');
            const box = el('div', 'eb-initial-routine');
            box.hidden = true;
            const title = labelledInput('初始任务名称'), prompt = labelledInput('初始任务指令', { multiline: true });
            title.input.maxLength = 80; prompt.input.maxLength = 8000;
            box.append(title.wrap, prompt.wrap);
            const schedule = this.routineFields(box);
            check.input.addEventListener('change', () => { box.hidden = !check.input.checked; });
            body.append(check.wrap, box);
            initialRoutine = () => {
                if (!check.input.checked) return [];
                if (!title.input.value.trim() || !prompt.input.value.trim()) throw new Error('请填写初始任务名称和指令');
                return [{ title: title.input.value.trim(), prompt: prompt.input.value, schedule: schedule(), enabled: true }];
            };
        }
        const error = el('p', 'eb-form-error');
        error.setAttribute('role', 'alert');
        body.append(error);
        const save = textButton(creating ? '创建机器人' : '保存修改', async () => {
            if (!name.input.value.trim()) {
                error.textContent = '请填写名称。';
                name.input.focus();
                return;
            }
            save.disabled = true;
            error.textContent = '';
            try {
                const payload = { name: name.input.value.trim(), description: description.input.value, rolePrompt: role.input.value, avatar };
                if (creating) {
                    payload.routines = initialRoutine();
                    const result = await this.adapter.createBot(payload);
                    this.current = result.id;
                }
                else
                    await this.adapter.updateBot({ ...payload, id: bot.id, revision: bot.revision });
                if (this.dead)
                    return;
                if (this.dialog?.element === dialog)
                    this.closeDialog();
                await this.refresh();
            }
            catch (e) {
                error.textContent = e.message ?? String(e);
            }
            finally {
                save.disabled = false;
            }
        });
        save.disabled = !this.cap(creating ? 'create' : 'profile');
        body.append(save);
        if (!this.cap(creating ? 'create' : 'profile'))
            body.append(el('p', 'eb-inline-note', '此版本尚未接入原生角色管理，不能保存；不会用本地模拟结果代替。'));
        if (bot) {
            body.append(el('hr'));
            if (this.cap('archive'))
                body.append(textButton(bot.archived ? '恢复此 bot' : '归档并暂停', () => { this.closeDialog(); void this.perform('archive', () => bot.archived ? this.adapter.restore(bot.id) : this.adapter.archive(bot.id)); }, 'eb-quiet'));
            if (this.cap('delete'))
                body.append(textButton('手动删除此 bot', () => this.confirmDelete(bot), 'eb-danger-link'));
        }
    }
    confirmStop(bot) {
        if (!bot) return;
        const { body, dialog } = this.openDialog(`停止 ${bot.name}`);
        body.append(el('p', '', '停止当前生成，并取消与此 bot 相关的待执行消息。其他 bot 已开始的任务不会被中止，定时任务定义也会保留。'));
        const stop = textButton('确认停止', async () => {
            stop.disabled = true;
            const ok = await this.perform('stop', () => this.adapter.stop(bot.id));
            if (ok && this.dialog?.element === dialog) this.closeDialog();
            stop.disabled = false;
        }, 'eb-button eb-danger');
        body.append(stop);
    }
    confirmDelete(bot) {
        const { body, dialog } = this.openDialog(`删除 ${bot.name}`);
        body.append(el('p', '', '删除后会取消它的定时任务，拒绝后续投递并清理数据。这个操作只能由你手动执行。'), el('code', 'eb-id', bot.id));
        const field = labelledInput(`输入“${bot.name}”确认`);
        body.append(field.wrap);
        const error = el('p', 'eb-form-error');
        body.append(error);
        const remove = textButton('永久删除', async () => { if (field.input.value !== bot.name)
            return; remove.disabled = true; try {
            await this.adapter.deleteBot({ id: bot.id, revision: bot.revision });
            if (this.dialog?.element === dialog)
                this.closeDialog();
            await this.refresh();
        }
        catch (e) {
            error.textContent = e.message;
            remove.disabled = false;
        } }, 'eb-button eb-danger');
        remove.disabled = true;
        field.input.addEventListener('input', () => { remove.disabled = field.input.value !== bot.name; });
        body.append(remove);
    }
    confirmRun(bot, r) {
        const { body, dialog } = this.openDialog('立即运行定时任务');
        body.append(el('p', '', `这会真实执行“${r.title}”，并在 ${bot.name} 的现有会话中产生结果。`));
        if (this.options.preview)
            body.append(el('p', 'eb-inline-note', '当前为预览：只会生成本地任务消息，不调用模型或闹钟。'));
        const run = textButton('确认运行', async () => { run.disabled = true; const ok = await this.perform('run', () => this.adapter.runRoutine({ id: r.id, revision: r.revision })); if (ok && this.dialog?.element === dialog)
            this.closeDialog(); run.disabled = false; });
        body.append(run);
    }
    routineFields(body, r) {
        const repeatWrap = el('label', 'eb-field', '重复');
        const repeat = el('select'); repeat.setAttribute('aria-label', '重复');
        for (const [value, label] of [['daily', '每天'], ['weekly', '每周'], ['monthly', '每月']]) {
            const option = el('option', '', label); option.value = value; repeat.append(option);
        }
        repeat.value = r?.repeat ?? 'daily'; repeatWrap.append(repeat);
        const time = labelledInput('执行时间', { value: r?.time ?? '08:30', type: 'time' });
        const weekday = labelledInput('星期（1=周一）', { value: String(r?.weekday ?? 1), type: 'number' });
        weekday.input.min = '1'; weekday.input.max = '7';
        const monthDay = labelledInput('每月几日', { value: String(r?.monthDay ?? 1), type: 'number' });
        monthDay.input.min = '1'; monthDay.input.max = '31';
        const update = () => { weekday.wrap.hidden = repeat.value !== 'weekly'; monthDay.wrap.hidden = repeat.value !== 'monthly'; };
        repeat.addEventListener('change', update); update();
        body.append(repeatWrap, time.wrap, weekday.wrap, monthDay.wrap,
            el('small', 'eb-muted', '按手机当前时区执行；每月不存在的日期跳过，不提前执行。'));
        return () => {
            const [hour, minute] = time.input.value.split(':').map(Number);
            if (!time.input.value || !Number.isInteger(hour) || !Number.isInteger(minute)) throw new Error('请选择执行时间');
            return { kind: repeat.value, hour, minute, weekday: Number(weekday.input.value), monthDay: Number(monthDay.input.value) };
        };
    }
    editRoutine(bot, r) {
        const { body, dialog } = this.openDialog(r ? '编辑定时任务' : '添加定时任务');
        const title = labelledInput('任务名称', { value: r?.title ?? '' });
        title.input.maxLength = 80;
        const prompt = labelledInput('任务指令', { value: r?.prompt ?? '', multiline: true });
        prompt.input.maxLength = 8000;
        prompt.input.rows = 4;
        body.append(title.wrap, prompt.wrap);
        const editableSchedule = !r || !!r.repeat;
        const schedule = editableSchedule ? this.routineFields(body, r) : null;
        if (!editableSchedule) body.append(el('p', 'eb-inline-note', `保留原有计划：${r.scheduleLabel} · ${r.timeZone}。此编辑器只改名称和指令。`));
        const error = el('p', 'eb-form-error');
        error.setAttribute('role', 'alert');
        body.append(error);
        const save = textButton('保存定时任务', async () => {
            error.textContent = '';
            if (!title.input.value.trim() || !prompt.input.value.trim()) {
                error.textContent = '请填写任务名称和指令。';
                return;
            }
            save.disabled = true;
            try {
                const payload = { ...(r ? { id: r.id, revision: r.revision } : {}), ownerSessionId: bot.id, title: title.input.value.trim(), prompt: prompt.input.value };
                if (schedule) payload.schedule = schedule();
                await this.adapter.saveRoutine(payload);
                if (this.dialog?.element === dialog)
                    this.closeDialog();
                await this.refresh();
            }
            catch (e) {
                error.textContent = e.message ?? String(e);
            }
            finally {
                save.disabled = false;
            }
        });
        body.append(save, el('p', 'eb-muted', '保存不立即执行。手机后台触发受 Android 权限和省电机制影响。'));
        this.motion.refresh();
    }
    dispose() { if (this.dead)
        return; this.closeDialog(); this.dead = true; this.generation++; this.unsubscribe?.(); this.motion.dispose(); window.removeEventListener('app-back', this.backListener); document.removeEventListener('keydown', this.keyListener, true); this.root.replaceChildren(); this.root.classList.remove('eb-root'); }
}
function isReplyVisible(parent, m) { return parent.source.kind === 'bot' && m.source.kind === 'bot' && ((parent.toSessionId === m.source.sessionId && parent.source.sessionId === m.toSessionId) || (parent.toSessionId === m.toSessionId && parent.source.sessionId === m.source.sessionId)); }
export function mountBotWorkspace(root, adapter, options) { return new BotWorkspace(root, adapter, options); }
