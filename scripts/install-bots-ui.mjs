import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const IMPORT = "import { BotWorkspacePage } from './bots/BotWorkspacePage';";
const ROUTE = '    <Route path="/bots/:sessionId?" element={<BotWorkspacePage/>}/>';
const ENTRY = '    <Row icon={<Grid2X2/>} title={t(\'机器人\',\'Bots\')} detail={t(\'角色、协作与定时任务\',\'Roles, collaboration & routines\')} onClick={() => nav(\'/bots\')}/>';
function insertOnce(source, anchor, replacement) { if (source.split(anchor).length !== 2)
    throw new Error(`Upstream changed: expected one anchor: ${anchor}`); return source.replace(anchor, replacement); }
export function installSources(app, settings) {
    let next = app;
    if (!next.includes(IMPORT))
        next = insertOnce(next, "import { SchedulesPage, ScheduleHistoryPage } from './Schedules';", "import { SchedulesPage, ScheduleHistoryPage } from './Schedules';\n" + IMPORT);
    if (!next.includes(ROUTE.trim()))
        next = insertOnce(next, '    <Route path="/chat/:conversationId?" element={<ChatPage/>}/>', ROUTE + '\n    <Route path="/chat/:conversationId?" element={<ChatPage/>}/>');
    let other = settings;
    if (!other.includes("nav('/bots')"))
        other = insertOnce(other, "</Section><Section title={t('AI 与工具','AI & tools')}>", "</Section><Section title={t('AI 与工具','AI & tools')}>\n" + ENTRY);
    if (!/\bGrid2X2\b/.test(other.split("from 'lucide-react'")[0]))
        throw new Error('Expected existing Grid2X2 import');
    return { app: next, settings: other };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const root = resolve(process.argv[2] ?? '.');
    const appPath = resolve(root, 'web/src/App.tsx'), settingsPath = resolve(root, 'web/src/Settings.tsx');
    const original = { app: readFileSync(appPath, 'utf8'), settings: readFileSync(settingsPath, 'utf8') };
    const next = installSources(original.app, original.settings); // Validate both BEFORE either write.
    if (next.app !== original.app)
        writeFileSync(appPath, next.app);
    if (next.settings !== original.settings)
        writeFileSync(settingsPath, next.settings);
    console.log('Added /bots route and Settings entry (idempotent). SessionBots native plugin is still required.');
}
