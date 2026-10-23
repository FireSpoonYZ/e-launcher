import { defineDoc } from '@earendil-works/pi-durable';

// M16 遗留迁移标记：session 域单值文档（latest，无 rewind），key 为 sourceKey，
// 值记录一次已完成的 Durable 映射（UUID->数字会话 ID、条目数与导入身份）。与
// PrimaryIndex/entries 在同一 commit 中原子写入；重复提交按完整身份校验，
// 绝不重复 append。
export const LegacyImportMarkers = defineDoc({
  kind: 'host.legacy-import-markers',
  version: 1,
  scope: 'session',
  initial: () => ({ bySourceKey: {} }),
});
