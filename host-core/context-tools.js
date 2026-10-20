import { defineTool } from '@earendil-works/pi-durable';
import {
  ACP_STATUS_TOOL,
  COMPRESS_TOOL,
  DECOMPRESS_TOOL,
  SEARCH_CONTEXT_TOOL,
} from 'acp-kernel';

// 内嵌 Billion Context：四个工具表面直接复用 acp-kernel 原始声明，执行映射到 controller。
const CONTEXT_TOOLS = [
  { declaration: COMPRESS_TOOL, method: 'compress' },
  { declaration: DECOMPRESS_TOOL, method: 'decompress' },
  { declaration: SEARCH_CONTEXT_TOOL, method: 'search' },
  { declaration: ACP_STATUS_TOOL, method: 'status' },
];

/** 注册 Billion Context 工具：name/description/parameters 取自声明，replay 安全。 */
export function createContextTools(controller) {
  return CONTEXT_TOOLS.map(({ declaration, method }) =>
    defineTool({
      name: declaration.name,
      description: declaration.description,
      parameters: declaration.input_schema,
      replay: 'safe',
      execute: (args, api, context) => controller[method](args, api, context),
    }),
  );
}
