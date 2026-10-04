import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { registerPlugin } from '@capacitor/core';
import { Archive, Download, Upload } from 'lucide-react';
import { Chat, type ConversationSummary } from './native';
import { ErrorNotice, Header, Section, useAction, useText } from './ui';

type Preview = { token: string; title: string; bytes: number; files: number; nodes: number; workspace: boolean; excluded: number; missingContexts: number; encrypted: false };
interface BackupPlugin {
  prepareExport(options: {conversationId: string; workspace: boolean}): Promise<Preview>;
  saveExport(options: {token: string}): Promise<{cancelled: boolean}>;
  chooseImport(): Promise<Preview | {cancelled: true}>;
  restoreImport(options: {token: string; workspace: boolean}): Promise<{conversationId: string}>;
  discard(): Promise<void>;
}
const Backup = registerPlugin<BackupPlugin>('ConversationBackup');

export function BackupsPage() {
  const t = useText(); const nav = useNavigate(); const action = useAction();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selected, setSelected] = useState('');
  const [workspace, setWorkspace] = useState(false);
  const [restoreWorkspace, setRestoreWorkspace] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  const [mode, setMode] = useState<'export' | 'import'>();
  const [message, setMessage] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void action.run(async () => {
      const [active, archived, snapshot] = await Promise.all([Chat.listConversations(), Chat.listArchivedConversations(), Chat.snapshot()]);
      if (!mounted.current) return;
      const values = [...active.conversations, ...archived.conversations];
      setConversations(values);
      setSelected(values.some(value => value.id === snapshot.conversationId) ? snapshot.conversationId : values[0]?.id ?? '');
    });
    return () => { mounted.current = false; void Backup.discard().catch(() => {}); };
  }, []);
  const reset = () => { setPreview(undefined); setMode(undefined); setMessage(''); };
  const prepare = () => action.run(async () => {
    reset();
    const value = await Backup.prepareExport({conversationId: selected, workspace});
    if (mounted.current) { setPreview(value); setMode('export'); }
    else await Backup.discard();
  });
  const choose = () => action.run(async () => {
    reset(); setRestoreWorkspace(false);
    const value = await Backup.chooseImport();
    if ('cancelled' in value) return;
    if (mounted.current) { setPreview(value); setMode('import'); }
    else await Backup.discard();
  });
  const save = () => action.run(async () => {
    const result = await Backup.saveExport({token: preview!.token});
    if (!result.cancelled) { reset(); setMessage(t('备份已保存。请保管好这个未加密文件。', 'Backup saved. Keep this unencrypted file private.')); }
  });
  const restore = () => action.run(async () => {
    const result = await Backup.restoreImport({token: preview!.token, workspace: restoreWorkspace});
    reset(); setMessage(t('已恢复为新会话，原会话保留。', 'Restored as a new conversation. Existing conversations are preserved.'));
    nav('/chat/' + result.conversationId);
  });
  return <main className="page backups-page">
    <Header title={t('会话备份', 'Conversation backups')} onBack={() => nav('/chat')}/>
    <p className="secondary">{t('备份含单个会话的全部分支、草稿、附件和 Pi 上下文。工作区可选。备份未加密；对话、附件或工作文件仍可能含隐私和密钥。', 'Back up one conversation with all branches, drafts, attachments and Pi contexts. Workspace files are optional. Backups are unencrypted; conversation content, attachments and work files may contain private data or secrets.')}</p>
    <p className="secondary">{t('不含全局设置、登录凭据、远程终端令牌、定时任务或运行中的操作。工作区排除隐藏文件、已知密钥文件、依赖、构建目录和符号链接。最多 128 MiB、4096 文件，单文件 32 MiB。', 'Global settings, saved credentials, terminal tokens, schedules and live operations are excluded. Workspace hidden files, known key files, dependencies, build folders and symlinks are excluded. Limits: 128 MiB total, 4096 files, 32 MiB per file.')}</p>
    <Section title={t('导出备份', 'Export backup')}>
      <label className="settings-row"><span className="row-copy">{t('选择会话', 'Conversation')}</span>
        <select aria-label={t('选择备份会话', 'Select conversation to back up')} value={selected} disabled={action.busy} onChange={event => { setSelected(event.target.value); reset(); }}>
          {!conversations.length && <option value="">{t('没有可备份会话', 'No saved conversations')}</option>}
          {conversations.map(value => <option key={value.id} value={value.id}>{value.title}{value.archivedAt ? t('（已归档）', ' (archived)') : ''}</option>)}
        </select>
      </label>
      <label className="settings-row"><span className="row-copy">{t('包括当前会话工作区', 'Include this conversation’s workspace')}</span><input type="checkbox" checked={workspace} disabled={action.busy} onChange={event => { setWorkspace(event.target.checked); reset(); }}/></label>
      <button className="button full" disabled={!selected || action.busy} onClick={() => void prepare()}><Download/>{t('准备并检查备份', 'Prepare and inspect backup')}</button>
    </Section>
    <Section title={t('从备份恢复', 'Restore backup')}>
      <p className="secondary">{t('先检查文件，再确认恢复。始终新建未归档的会话；不会覆盖现有会话、恢复运行、重放工具或恢复旧的归档倒计时。', 'Inspect the file before confirming. Restore always creates a new unarchived conversation. It never overwrites existing conversations, resumes runs, replays tools or restores an old archive deadline.')}</p>
      <button className="button full" disabled={action.busy} onClick={() => void choose()}><Upload/>{t('选择并检查备份', 'Choose and inspect backup')}</button>
    </Section>
    {preview && <Section title={mode === 'export' ? t('确认导出范围', 'Confirm export scope') : t('确认恢复范围', 'Confirm restore scope')}>
      <p><Archive/> {preview.title}</p>
      <p>{preview.nodes} {t('节点', 'nodes')} · {preview.files} {t('文件', 'files')} · {(preview.bytes / 1048576).toFixed(2)} MiB</p>
      <p>{preview.workspace ? t('备份包括工作区', 'Backup includes workspace files') : t('不包括工作区', 'No workspace files')} · {t('已排除的文件或目录：', 'Excluded files or directories: ')}{preview.excluded}</p>
      {!!preview.missingContexts && <p role="alert">{t(`原会话有 ${preview.missingContexts} 个节点缺少 Pi 原生上下文；其记录会保留，但可能无法从这些节点继续。`, `${preview.missingContexts} original nodes lack Pi contexts. Their history is preserved, but continuing from them may be unavailable.`)}</p>}
      {mode === 'import' && preview.workspace && <label className="settings-row"><span className="row-copy">{t('同时恢复工作区文件', 'Also restore workspace files')}</span><input type="checkbox" checked={restoreWorkspace} disabled={action.busy} onChange={event => setRestoreWorkspace(event.target.checked)}/></label>}
      {mode === 'import' && <p className="secondary">{t('仅恢复可信来源。工作文件和历史工具输出仍是不可信内容，文本中的旧绝对路径不会改写。', 'Restore only trusted backups. Work files and historical tool output remain untrusted. Old absolute paths in historical text are not rewritten.')}</p>}
      <button className="button full" disabled={action.busy} onClick={() => void (mode === 'export' ? save() : restore())}>{mode === 'export' ? t('保存未加密备份…', 'Save unencrypted backup…') : t('确认恢复为新会话', 'Confirm restore as new conversation')}</button>
      <button className="quiet-button full" disabled={action.busy} onClick={() => void action.run(async () => { await Backup.discard(); reset(); })}>{t('取消', 'Cancel')}</button>
    </Section>}
    {action.busy && <p role="status">{t('正在处理，请稍候…', 'Processing, please wait…')}</p>}
    {message && <p role="status">{message}</p>}
    <ErrorNotice error={action.error}/>
  </main>;
}
