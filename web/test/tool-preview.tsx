// Local visual fixture: npx vite --host 127.0.0.1, then /test/tool-preview.html.
// Uses the production component; never included in the app's entry bundle.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUp, Menu, Plus } from 'lucide-react';
import { ToolCallView } from '../src/ToolCallView';
import '../src/styles.css';

const result = (id: string, content: string) => ({id, parentId: null, message: {id, role: 'tool' as const, content, toolCallId: id, toolCalls: [], incomplete: false}});
function Preview() {
  const [output, setOutput] = useState<string | null>(null);
  const [running, setRunning] = useState(true);
  const [path, setPath] = useState('web/src/Chat.tsx');
  Object.assign(window, {toolPreview: {setOutput, setRunning, setPath}});
  return <main className="chat-page">
    <header className="chat-header"><Menu/><div className="model-title"><strong>Pi</strong><span>工具调用</span></div><Plus/></header>
    <section className="messages">
      <p>我来检查文件，并验证构建结果。</p>
      <ToolCallView tool={{id:'read', name:'Read', arguments:JSON.stringify({path})}} results={[result('read', 'export function ChatPage() {\n  const chat = useChat();\n  return <main>...</main>;\n}')]} />
      <ToolCallView tool={{id:'build', name:'Bash', arguments:'{"command":"npm run build","timeout":60}'}} results={[result('build', '✓ 2064 modules transformed.\n✓ built in 6.09s\n\nMore build details follow here.')]} />
      <ToolCallView tool={{id:'test', name:'Bash', arguments:'{"command":"npm run test"}'}} results={output === null ? [] : [result('test', output)]} pending={running}/>
      <p>构建通过，接下来检查手机上的显示。</p>
    </section>
    <footer className="composer-wrap"><div className="composer"><textarea aria-label="消息" placeholder="发消息…" rows={1}/><div className="composer-tools"><button className="icon-button" aria-label="添加"><Plus/></button><span className="composer-spacer"/><button className="send-button" aria-label="发送"><ArrowUp/></button></div></div></footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
