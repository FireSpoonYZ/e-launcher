import { mountBotWorkspace } from '../../src/bots/workspace.mjs';
import { PreviewAdapter } from './preview-adapter.mjs';
const adapter = new PreviewAdapter();
const workspace = mountBotWorkspace(document.getElementById('bots-root'), adapter, { initialSessionId: 'jarvis', preview: true });
// Deliberate preview-only test hook. Never imported by the app route or the native adapter.
window.botPreview = { adapter, workspace };
