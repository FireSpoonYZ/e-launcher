import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function content(result) {
  if (!Array.isArray(result)) throw new Error("Android 应用查询响应无效");
  const apps = result.map((app) => {
    if (!app || typeof app.label !== "string" || typeof app.packageName !== "string") {
      throw new Error("Android 应用查询响应无效");
    }
    return { label:app.label, packageName:app.packageName };
  });
  return { content:[{ type:"text", text:JSON.stringify(apps) }] };
}

/** Read-only Pi tools backed by Android's current-user installed-app catalog. */
export function createAppTools({ request }) {
  if (typeof request !== "function") throw new TypeError("Android 应用查询 bridge 不可用");
  return [
    defineTool({
      name:"list_apps",
      label:"List installed apps",
      description:"列出当前用户全部已安装应用，包括系统应用和没有 launcher 入口的应用，仅返回 label 和 packageName。通常应优先使用 search_apps 按关键词查找；取得真实 packageName 后再调用 shower 的 launch。",
      parameters:Type.Object({}, { additionalProperties:false }),
      async execute(_toolCallId, _arguments, signal) {
        signal?.throwIfAborted();
        return content(await request({ action:"list" }, signal));
      },
    }),
    defineTool({
      name:"search_apps",
      label:"Search installed apps",
      description:"优先用非空关键词查找当前用户已安装应用；忽略大小写，只要应用名或包名包含关键词即匹配，仅返回 label 和 packageName。取得真实 packageName 后再调用 shower 的 launch。",
      parameters:Type.Object({ query:Type.String({ minLength:1, description:"应用名或包名关键词" }) },
        { additionalProperties:false }),
      async execute(_toolCallId, arguments_, signal) {
        const query = arguments_?.query;
        if (typeof query !== "string" || !query.trim()) throw new Error("query 必须是非空关键词");
        signal?.throwIfAborted();
        return content(await request({ action:"search", query:query.trim() }, signal));
      },
    }),
  ];
}
