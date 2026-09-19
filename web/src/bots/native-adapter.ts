import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { BotUiAdapter, Capability } from './workspace.mjs';
import type { Chat } from '../native';
/** The registered Android Bots plugin is the single authoritative data source. */
interface SessionBotsPlugin {
    workspace(): Promise<{
        snapshot: unknown;
        capabilities: Partial<Record<Capability, boolean>>;
    }>;
    addListener(event: 'botsChanged', listener: () => void): Promise<PluginListenerHandle>;
    uiAction(input: {
        action: string;
        input: Record<string, unknown>;
    }): Promise<unknown>;
}
const plugin = registerPlugin<SessionBotsPlugin>('Bots');
const capabilities: Capability[] = ['send', 'stop', 'create', 'profile', 'routines', 'restore', 'archive', 'delete', 'selectModel'];
export class NativeBotUiAdapter implements BotUiAdapter {
    capabilities: Partial<Record<Capability, boolean>> = {};
    private requireNative(): void {
        if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('Bots')) {
            throw new Error('此工作台需要安装支持 Bots 的 Android APK；浏览器预览不连接原生会话。');
        }
    }
    async read(): Promise<unknown> {
        this.requireNative();
        const response = await plugin.workspace();
        this.capabilities = Object.fromEntries(capabilities.map(key => [key, response.capabilities?.[key] === true]));
        return response.snapshot;
    }
    async subscribe(listener: () => void): Promise<() => void> {
        if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('Bots'))
            return () => { };
        const handle = await plugin.addListener('botsChanged', listener);
        return () => { void handle.remove(); };
    }
    private action(action: string, input: Record<string, unknown>): Promise<unknown> {
        this.requireNative();
        return plugin.uiAction({ action, input });
    }
    send(input: {
        toSessionId: string;
        body: string;
        submissionId: string;
    }) { return this.action('sendUserMessage', input); }
    stop(id: string) { return this.action('stop', { id }); }
    selectModel(input: Parameters<typeof Chat.selectModel>[0]) {
        const { conversationId, ...selection } = input;
        return this.action('selectModel', { id: conversationId, ...selection }) as ReturnType<typeof Chat.selectModel>;
    }
    async createBot(input: Record<string, unknown>): Promise<{
        id: string;
    }> {
        const result = await this.action('createBot', input) as {
            id?: unknown;
        };
        if (typeof result?.id !== 'string')
            throw new Error('原生创建响应缺少会话 ID');
        return { id: result.id };
    }
    updateBot(input: Record<string, unknown>) { return this.action('updateBot', input); }
    archive(id: string) { return this.action('archive', { id }); }
    restore(id: string) { return this.action('restore', { id }); }
    deleteBot(input: {
        id: string;
        revision: number;
    }) { return this.action('deleteBot', input); }
    saveRoutine(input: Record<string, unknown>) { return this.action('saveRoutine', input); }
    setRoutineEnabled(input: {
        id: string;
        revision: number;
        enabled: boolean;
    }) { return this.action('setRoutineEnabled', input); }
    runRoutine(input: {
        id: string;
        revision: number;
    }) { return this.action('runRoutine', input); }
}
