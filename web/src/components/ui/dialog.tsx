import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useText } from '../../ui';

export function Dialog({ open, onOpenChange, title, children, sheet = false, drawer = false }: { open: boolean; onOpenChange(open: boolean): void; title: string; children: ReactNode; sheet?: boolean; drawer?: boolean }) {
  const t = useText();
  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="dialog-overlay" />
      <DialogPrimitive.Content className={`dialog-content ${sheet ? 'sheet' : drawer ? 'drawer' : ''}`} onOpenAutoFocus={event => { event.preventDefault(); requestAnimationFrame(() => document.querySelector<HTMLElement>('[role="dialog"]')?.focus()); }}>
        {sheet && <div className="sheet-handle" />}
        <header className="dialog-header"><DialogPrimitive.Title>{title}</DialogPrimitive.Title><DialogPrimitive.Close className="icon-button" aria-label={t('关闭','Close')}><X /></DialogPrimitive.Close></header>
        <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
        <div className="dialog-body">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}

export function ConfirmDialog({ open, title, description, danger, onCancel, onConfirm }: { open: boolean; title: string; description: string; danger?: boolean; onCancel(): void; onConfirm(): void }) {
  const t = useText();
  return <Dialog open={open} onOpenChange={value => !value && onCancel()} title={title}>
    <p className="secondary">{description}</p><div className="dialog-actions"><button className="button secondary-button" onClick={onCancel}>{t('取消','Cancel')}</button><button className={danger ? 'button danger-button' : 'button'} onClick={onConfirm}>{t('确认','Confirm')}</button></div>
  </Dialog>;
}
