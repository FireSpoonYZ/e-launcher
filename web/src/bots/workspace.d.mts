import type { AskUserQuestionnaire, Conversation } from '../native';
export type Capability = 'send'|'stop'|'create'|'profile'|'routines'|'restore'|'archive'|'delete'|'selectModel';
export interface WorkspaceBot {
  id: string; name: string; archived: boolean; running: boolean;
  piSelection: Conversation['piSelection'];
  requestId: string|null; askUser: AskUserQuestionnaire|null;
  questionnairePending: boolean; questionnaireError: string;
}
export interface BotUiAdapter {
  capabilities: Partial<Record<Capability, boolean>>;
  read(): Promise<unknown>;
  subscribe?(listener: () => void): (() => void)|Promise<() => void>;
  send(input: {toSessionId: string; body: string; submissionId: string}): Promise<unknown>;
  stop(id: string): Promise<unknown>;
  createBot(input: Record<string, unknown>): Promise<{id: string}>;
  updateBot(input: Record<string, unknown>): Promise<unknown>;
  archive(id: string): Promise<unknown>;
  restore(id: string): Promise<unknown>;
  deleteBot(input: {id: string; revision: number}): Promise<unknown>;
  saveRoutine(input: Record<string, unknown>): Promise<unknown>;
  setRoutineEnabled(input: {id: string; revision: number; enabled: boolean}): Promise<unknown>;
  runRoutine(input: {id: string; revision: number}): Promise<unknown>;
}
export interface WorkspaceOptions {
  initialSessionId?: string;
  onExit?: () => void;
  onOpenChat?: (id: string) => void|Promise<void>;
  onBotChange?: (bot: WorkspaceBot|undefined) => void;
  onOpenModel?: () => void;
  preview?: boolean;
}
export class BotWorkspace { constructor(root: HTMLElement, adapter: BotUiAdapter, options?: WorkspaceOptions); dispose():void; select(id: string):void; applySession(id?: string):void; refresh():Promise<void>; questionnaireHost: HTMLElement; }
export function mountBotWorkspace(root: HTMLElement, adapter: BotUiAdapter, options?: WorkspaceOptions): BotWorkspace;
