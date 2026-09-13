import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const key = Type.Union([
  "BACK", "HOME", "ENTER", "TAB", "ESCAPE", "SPACE", "DEL", "FORWARD_DEL", "A", "COPY", "CUT", "PASTE",
  "DPAD_UP", "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT", "DPAD_CENTER",
  "PAGE_UP", "PAGE_DOWN", "MOVE_HOME", "MOVE_END",
].map((value) => Type.Literal(value)));
const modifier = Type.Union(["SHIFT", "ALT", "CTRL", "META"].map((value) => Type.Literal(value)));
const coordinate = (description) => Type.Integer({ minimum: 0, description });

/** Pi tool backed by the Android host's conversation-owned Operit Shower virtual display. */
export function createShowerTool({ request }) {
  if (typeof request !== "function") throw new TypeError("Shower native bridge is unavailable");
  return defineTool({
    name: "shower",
    label: "Operit Shower",
    description: "只操作宿主分配给当前聊天的 Operit Shower 虚拟屏，不操作手机主屏或其他聊天的屏幕；每个聊天各自一块屏。先 create（默认 720×1280，会自动启动 Shower），再 launch；同一聊天 create 可复用现有屏幕。每次动作后用 screenshot 核实。屏幕可跨回复保留，5 分钟没有工具操作会自动回收；确定不再使用时 release，仅释放本聊天的屏幕。最后一块屏幕关闭后 Shower 空闲 15 秒自动退出。同一应用不能同时由不同聊天的虚拟屏占用，launch 冲突会报错。tap/swipe 坐标始终使用 create 返回的虚拟屏尺寸。截图可能按 maxWidth/maxHeight 等比缩小，返回文字会同时给出虚拟尺寸和图片尺寸；不要把缩小后的图片坐标直接当虚拟坐标。先点击目标输入框再 text：通过系统剪贴板粘贴中文等 Unicode 文本，并全选替换原内容；text 为空或 clear 清空整个输入框。copy(text) 把给定文字写入系统剪贴板；paste 在当前光标处粘贴，替换选中部分。key COPY/CUT 操作当前选区，key A 配合 CTRL 全选。系统剪贴板与主屏应用共享，text/copy 会覆盖剪贴板；按键被系统接受不代表输入框已改变，必须截图确认。服务断开或屏幕空闲超时后先 create，再 launch 和截图重新定位，不要盲目重放旧坐标或动作。",
    parameters: Type.Union([
      Type.Object({
        action: Type.Literal("create"),
        width: Type.Optional(Type.Integer({ minimum: 320, maximum: 1440, description: "虚拟屏宽；会向上对齐到 16 像素" })),
        height: Type.Optional(Type.Integer({ minimum: 320, maximum: 3200, description: "虚拟屏高；会向上对齐到 16 像素" })),
        dpi: Type.Optional(Type.Integer({ minimum: 120, maximum: 640 })),
        bitrateKbps: Type.Optional(Type.Integer({ minimum: 128, maximum: 12000, description: "内部显示 Surface 的 H.264 码率" })),
      }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("launch"), packageName: Type.String({ minLength: 3, maxLength: 255,
        description: "要在虚拟屏启动的 Android 包名，例如 com.android.settings" }) }, { additionalProperties: false }),
      Type.Object({
        action: Type.Literal("screenshot"),
        maxWidth: Type.Optional(Type.Integer({ minimum: 160, maximum: 1440, description: "返回图片最大宽度，默认 720" })),
        maxHeight: Type.Optional(Type.Integer({ minimum: 160, maximum: 3200, description: "返回图片最大高度，默认 1280" })),
      }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("tap"), x: coordinate("虚拟屏 x"), y: coordinate("虚拟屏 y") },
        { additionalProperties: false }),
      Type.Object({ action: Type.Literal("swipe"), x1: coordinate("起点虚拟屏 x"), y1: coordinate("起点虚拟屏 y"),
        x2: coordinate("终点虚拟屏 x"), y2: coordinate("终点虚拟屏 y"),
        durationMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000, description: "默认 300ms" })) },
        { additionalProperties: false }),
      Type.Object({ action: Type.Literal("key"), key,
        modifiers: Type.Optional(Type.Array(modifier, { uniqueItems: true, maxItems: 4 })) },
        { additionalProperties: false }),
      Type.Object({ action: Type.Literal("text"), text: Type.String({ maxLength: 1000,
        description: "替换已聚焦输入框的全部内容，支持中文；空字符串清空输入框" }) },
        { additionalProperties: false }),
      Type.Object({ action: Type.Literal("copy"), text: Type.String({ minLength: 1, maxLength: 1000,
        description: "写入系统剪贴板的文字，不修改输入框；复制当前选区请用 key COPY" }) },
        { additionalProperties: false }),
      Type.Object({ action: Type.Literal("paste") }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("clear") }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("release") }, { additionalProperties: false }),
    ]),
    async execute(_toolCallId, arguments_, signal) {
      signal?.throwIfAborted();
      const result = await request(arguments_, signal);
      if (!result || typeof result !== "object") throw new Error("Shower 原生响应无效");
      if (arguments_.action !== "screenshot") {
        return { content: [{ type: "text", text: JSON.stringify(result) }],
          details: { engine: "operit-shower", action: arguments_.action, displayId: result.displayId } };
      }
      const { data, mimeType, ...metadata } = result;
      if (mimeType !== "image/png" || typeof data !== "string" || data.length === 0) {
        throw new Error("Shower 截图响应无效");
      }
      const text = `虚拟屏 ${result.width}×${result.height}；返回图片 ${result.imageWidth}×${result.imageHeight}。`;
      return { content: [{ type: "text", text }, { type: "image", data, mimeType }],
        details: { engine: "operit-shower", ...metadata } };
    },
  });
}
