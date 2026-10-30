// 桌面端 Bot 头像定制（仅本地展示层）。
// 持久化复用与手机端同一 localStorage 键（bot-hub-avatar-config-v2）与 Grok preset 体系：
// 形状/颜色/表情全部来自 GROK_* 常量，不自造存储格式；reset 回到按 botKey 派生的默认 preset。
import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  GROK_COLOR_PALETTE,
  GROK_EXPRESSION_LIST,
  GROK_SHAPE_ORDER,
  GrokBotAvatar,
  getDefaultBotAvatarPreset,
  resetBotAvatarConfig,
  resolveBotAvatarPreset,
  saveBotAvatarConfig,
  type GrokAvatarPreset,
} from '../../../web/src/GrokBotAvatar';

export function BotAvatarStudio({
  botKey,
  roleName,
  isPrimary,
  onChanged,
}: {
  /** 与手机端同一约定键：local:local:<botId> / remote:<profileId>:<deviceId>:<botId>。 */
  botKey: string;
  roleName?: string;
  isPrimary?: boolean;
  /** 持久化后回调（供外层 bump avatarVersion，刷新其它 avatar 实例）。 */
  onChanged?: () => void;
}) {
  const [draft, setDraft] = useState<GrokAvatarPreset>(() =>
    resolveBotAvatarPreset(botKey, roleName, isPrimary),
  );
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setDraft(resolveBotAvatarPreset(botKey, roleName, isPrimary));
    setDirty(false);
  }, [botKey, roleName, isPrimary]);

  function save() {
    saveBotAvatarConfig(botKey, draft);
    setDirty(false);
    onChanged?.();
  }

  function reset() {
    resetBotAvatarConfig(botKey);
    setDraft({ ...getDefaultBotAvatarPreset(botKey, roleName, isPrimary) });
    setDirty(false);
    onChanged?.();
  }

  return (
    <div className="avatar-studio">
      <div className="avatar-studio-preview">
        <GrokBotAvatar preset={draft} size={96} isPrimary={isPrimary} starBadge={isPrimary} />
      </div>

      <div className="avatar-studio-section-title">形状</div>
      <div className="avatar-shape-grid" role="listbox" aria-label="形状">
        {GROK_SHAPE_ORDER.map((item) => {
          const selected = draft.shape === item.shape;
          return (
            <button
              key={item.shape}
              type="button"
              className={`avatar-shape-cell${selected ? ' selected' : ''}`}
              title={item.labelZh}
              aria-pressed={selected}
              onClick={() => {
                setDirty(true);
                setDraft((prev) => ({
                  ...prev,
                  id: `${item.shape}-${prev.color}`,
                  shape: item.shape,
                  rotation: item.rotation,
                }));
              }}
            >
              <GrokBotAvatar
                preset={{ ...draft, shape: item.shape, rotation: item.rotation }}
                size={40}
              />
            </button>
          );
        })}
      </div>

      <div className="avatar-studio-section-title">表情</div>
      <div className="avatar-expression-grid" role="listbox" aria-label="表情">
        {GROK_EXPRESSION_LIST.map((expr) => {
          const selected = draft.expressionIndex === expr.index;
          return (
            <button
              key={expr.index}
              type="button"
              className={`avatar-expression-cell${selected ? ' selected' : ''}`}
              title={expr.labelZh}
              aria-pressed={selected}
              onClick={() => {
                setDirty(true);
                setDraft((prev) => ({ ...prev, expressionIndex: expr.index }));
              }}
            >
              <GrokBotAvatar
                preset={{ ...draft, expressionIndex: expr.index }}
                size={46}
              />
              <span>{expr.labelZh}</span>
            </button>
          );
        })}
      </div>

      <div className="avatar-studio-section-title">颜色</div>
      <div className="avatar-color-grid" role="listbox" aria-label="颜色">
        {GROK_COLOR_PALETTE.map((c) => {
          const selected = draft.color.toLowerCase() === c.hex.toLowerCase();
          return (
            <button
              key={c.id}
              type="button"
              className={`avatar-color-swatch${selected ? ' selected' : ''}`}
              title={c.labelZh}
              aria-pressed={selected}
              onClick={() => {
                setDirty(true);
                setDraft((prev) => ({ ...prev, id: `${prev.shape}-${c.id}`, color: c.hex }));
              }}
            >
              <span style={{ backgroundColor: c.hex }} />
            </button>
          );
        })}
      </div>

      <div className="avatar-studio-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={reset}
          title="放弃自定义并恢复该 Bot 的默认头像"
        >
          <RotateCcw size={14} /> 恢复默认
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={!dirty}
          onClick={save}
          title="保存到本机，仅影响此 Bot 的展示形象"
        >
          {dirty ? '保存形象' : '已保存'}
        </button>
      </div>
      <p className="avatar-studio-hint">
        头像仅保存在本机（与手机端同一存储约定），不上传中心、不影响 Bot 数据。
      </p>
    </div>
  );
}
