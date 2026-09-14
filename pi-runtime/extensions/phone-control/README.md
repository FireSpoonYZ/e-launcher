# @e-launcher/pi-phone-control

独立的 Pi extension，注册三个 Android 工具：

- `list_apps`：列出当前用户已安装应用。
- `search_apps`：按应用名或包名搜索。
- `shower`：控制当前聊天拥有的 Operit Shower 虚拟屏，包含创建、启动应用、截图、输入和释放。

工具参数、结果格式和原生调用行为沿用原实现。扩展不依赖 e-launcher 的 SDK 会话实现；Android 宿主负责实际执行、权限、请求取消、超时和虚拟屏归属。

## 宿主接入

扩展导出标准 `default (pi)` 入口，加载时通过 `pi.events.emit("phone-control:bridge", bridge)` 同步取得宿主能力。宿主需在加载前，为当前操作的 event bus 注册监听器，向 `bridge` 写入以下回调：

- `requestApps(arguments, signal)`：接收 `{ action: "list" }` 或 `{ action: "search", query }`，返回 `{ label, packageName }[]`。
- `requestShower(arguments, signal)`：接收 Shower 工具参数，返回原生结果对象；截图结果包含 `data`（PNG base64）、`mimeType: "image/png"`、虚拟尺寸 `width/height` 和图片尺寸 `imageWidth/imageHeight`。

回调返回 Promise，失败时 reject，并负责响应 AbortSignal。未提供的能力不注册对应工具；两个回调均缺失时报告加载错误。每个聊天操作使用独立 event bus 和绑定到该操作的回调，不能使用进程全局 bridge。

e-launcher 在 `pi-runtime/android.js` 中提供回调，并通过 `resourceLoaderOptions.extensionFactories` 加载名为 `phone-control` 的扩展。`sdk.js` 仅传递通用资源加载参数。扩展源码随 Android runtime 一起打包，无需手机额外安装 npm 包。资源列表显示为 `<inline:phone-control>`；此内置加载方式不提供包资源开关。

其他 Android SDK 宿主也可通过 `package.json` 中的 `pi.extensions` 加载本包，并按上述约定提供同一个 loader 的 event bus。普通桌面 Pi 不提供 Android bridge，单独安装本包不能控制手机。

## 单独打包

在仓库根目录执行：

```powershell
New-Item -ItemType Directory -Force build/packages | Out-Null
npm pack ./pi-runtime/extensions/phone-control --pack-destination ./build/packages
```

包内包含入口、工具实现和本说明。Pi SDK 与 TypeBox 使用宿主提供的 peer dependencies。
