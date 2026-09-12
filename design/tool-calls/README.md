# 工具调用块

## 采用的设计

`tool-call-redesign-refined.png` 是生成并检查后的设计参考；`tool-call-redesign.png` 是初稿。只调整聊天中的工具组件，不改聊天导航、输入区或原生消息存储。

- 一个调用与其结果共用一个块。
- 顶行显示工具名和“已返回 / 等待结果 / 无结果”。“已返回”仅表示存在结果，不推断成功或失败。
- 默认显示关键参数及最多三行文本结果预览；展开后显示完整原始参数和结果。
- 参数摘要依次提取 command、cmd、filePath、path、file、url、query、code。无法提取时保留原始文本摘要。
- 12px 外圆角、14px 内边距、低对比表面、单层结构。正文代码使用 14px 等宽字体，完整输出可以滚动。
- 沿用现有浅色/深色变量、原生 details 键盘交互、稳定组件 key 和减少动态效果偏好。

设计参考：Pico 的轻量聊天布局、Remote Pi 默认可见的参数和状态、Pi Desktop 的参数摘要。折叠时显示少量结果是本项目的选择，不是这些参考项目都具备的行为。

## 验证入口

```sh
node --test web/test/toolResults.test.mjs
npm run build
npx vite --host 127.0.0.1 --port 5178
```

打开 `http://127.0.0.1:5178/test/tool-preview.html`，在控制台运行：

```js
(await import('/test/tool-preview-check.js')).checkToolPreview()
```

该页面使用真实 `ToolCallView` 和生产 CSS，仅测试数据是本地固定样例，不连接手机会话。检查默认结果预览、展开/收起、结果到达时保持展开、完整结果不截断、HTML 文本转义、长参数不撑宽页面、停止后的状态。

已人工查看 390px 浅色折叠布局和 320px 深色展开布局，浏览器交互检查通过。生成图是视觉参考，浏览器检查才是实际实现证据。
