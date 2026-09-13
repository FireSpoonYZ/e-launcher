import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const key = Type.Union([
  "BACK", "HOME", "ENTER", "TAB", "ESCAPE", "SPACE", "DEL", "FORWARD_DEL",
  "DPAD_UP", "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT", "DPAD_CENTER",
  "PAGE_UP", "PAGE_DOWN", "MOVE_HOME", "MOVE_END",
].map((value) => Type.Literal(value)));
const modifier = Type.Union(["SHIFT", "ALT", "CTRL", "META"].map((value) => Type.Literal(value)));
const coordinate = (description) => Type.Integer({ minimum: 0, description });

/** Pi tool backed by the Android host's single Operit Shower virtual display. */
export function createShowerTool({ request }) {
  if (typeof request !== "function") throw new TypeError("Shower native bridge is unavailable");
  return defineTool({
    name: "shower",
    label: "Operit Shower",
    description: "只操作一个隔离的 Operit Shower 虚拟屏，不操作手机主屏。先 create（默认 720×1280），再 launch；每次动作后用 screenshot 核实，结束必须 release。tap/swipe 坐标始终使用 create 返回的虚拟屏尺寸。截图可能按 maxWidth/maxHeight 等比缩小，返回文字会同时给出虚拟尺寸和图片尺寸；不要把缩小后的图片坐标直接当虚拟坐标。text 使用 Android 虚拟键盘，无法生成的字符会明确报错。服务或虚拟屏丢失后重新 create，不要盲目重放动作。",
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
      Type.Object({ action: Type.Literal("text"), text: Type.String({ minLength: 1, maxLength: 1000 }) },
        { additionalProperties: false }),
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
