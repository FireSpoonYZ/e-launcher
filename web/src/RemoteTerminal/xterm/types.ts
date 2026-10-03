// Extracted from @xterm/xterm 6.1.0-beta.303 src/common/Types.ts (MIT).
export interface IKeyboardEvent {
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  /** @deprecated See KeyboardEvent.keyCode */
  keyCode: number;
  key: string;
  type: string;
  code: string;
}

export const KeyboardResultType = { SEND_KEY: 0, SELECT_ALL: 1, PAGE_UP: 2, PAGE_DOWN: 3 } as const;
export type KeyboardResultType = number;

export interface IKeyboardResult {
  type: KeyboardResultType;
  cancel: boolean;
  key: string | undefined;
}