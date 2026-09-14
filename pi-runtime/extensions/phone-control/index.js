import { createShowerTool } from "./shower.js";
import { createAppTools } from "./apps.js";

/** The host supplies conversation-bound native callbacks through this loader's event bus. */
export default function phoneControl(pi) {
  const bridge = {};
  pi.events.emit("phone-control:bridge", bridge);
  if (!bridge.requestApps && !bridge.requestShower) {
    throw new Error("phone-control 需要 Android 宿主提供原生 bridge");
  }
  if (bridge.requestApps) {
    for (const tool of createAppTools({ request: bridge.requestApps })) pi.registerTool(tool);
  }
  if (bridge.requestShower) pi.registerTool(createShowerTool({ request: bridge.requestShower }));
}
