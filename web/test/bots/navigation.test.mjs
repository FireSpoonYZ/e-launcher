import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isAiPagerHash, botsSessionFromHash } from '../../src/bots/routes.mjs';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('desktop pager stays enabled on workspace and explicit full chat', () => {
    for (const hash of ['#/bots', '#/bots/', '#/bots/active-id', '#/chat', '#/chat/', '#/chat/active-id', '#/chat?panel=models'])
        assert.equal(isAiPagerHash(hash), true, hash);
    for (const hash of ['#/settings', '#/settings/voice', '#/history/x', '#/archived', '#/schedules', '#/', '#/chatty', '#/bots-admin'])
        assert.equal(isAiPagerHash(hash), false, hash);
});

test('native /bots/{activeId} maps to workspace current; bare /bots does not invent an id', () => {
    assert.equal(botsSessionFromHash('#/bots/active-id'), 'active-id');
    assert.equal(botsSessionFromHash('#/bots/a%2Fb'), 'a/b');
    assert.equal(botsSessionFromHash('#/bots'), undefined);
    assert.equal(botsSessionFromHash('#/bots?tab=chat'), undefined);
    assert.equal(botsSessionFromHash('#/chat/active-id'), undefined);
});

test('default AI entries use the workspace; old full chat and models stay explicit', async () => {
    const [app, main, page, ui, activity, device, workspace] = await Promise.all([
        read('../../src/App.tsx'),
        read('../../src/main.tsx'),
        read('../../src/bots/BotWorkspacePage.tsx'),
        read('../../src/ui.tsx'),
        read('../../../app/src/main/java/com/example/launcherprobe/MainActivity.java'),
        read('../../../app/src/main/java/com/example/launcherprobe/DevicePlugin.java'),
        read('../../src/bots/workspace.mjs'),
    ]);
    assert.match(app, /isAiPagerHash\(window\.location\.hash\)/);
    assert.match(app, /<Route path="\/bots\/:sessionId\?" element=\{<BotWorkspacePage\/>\}\/>/);
    assert.match(app, /<Route path="\/chat\/:conversationId\?" element=\{<ChatPage\/>\}\/>/);
    assert.match(app, /<Navigate to="\/bots" replace\/>/);
    assert.doesNotMatch(app, /startsWith\('#\/chat'\)/);
    assert.match(main, /launchRoute \|\| '\/bots'/);
    assert.doesNotMatch(main, /'\s*\/chat\s*'/);
    assert.match(page, /native-navigation/);
    assert.match(page, /applySession\(botsSessionFromHash\(\)\)/);
    assert.match(page, /onExit: \(\) => backRef\.current\(\)/);
    assert.match(page, /navigate\(`\/chat\/\$\{encodeURIComponent\(id\)\}`\)/);
    assert.doesNotMatch(page, /onExit: \(\) => navigate\('\/chat'\)/);
    assert.match(ui, /navigate\('\/bots', \{replace: true\}\)/);
    assert.match(workspace, /applySession\(id\)/);
    assert.match(device, /"\/bots"/);
    assert.match(activity, /initialWebRoute = "\/bots\/" \+/);
    assert.match(activity, /launchRoute\(\) \{ return initialWebRoute == null \? "\/bots"/);
    assert.match(activity, /return "\/bots\/" \+ conversationId/);
    assert.match(activity, /\/\^#\\\\\/\(\?:chat\|bots\)\(\?:\\\\\/\|\$\|\\\\\?\)\//);
    assert.match(activity, /launchWeb\("\/chat\?panel=models"/);
    assert.match(activity, /launchWeb\("\/settings"/);
    assert.match(activity, /launchWeb\("\/history\/"/);
    assert.doesNotMatch(activity, /launchWeb\("\/chat\/"/);
    assert.match(activity, /initialWebRoute\.startsWith\("\/chat"\)/);
});
