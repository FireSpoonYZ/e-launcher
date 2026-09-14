import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useText } from './ui';

// Pointer interaction must not move focus away from the composer or dismiss the IME.
export function ComposerPopover({title, close, children, compact = false, open = true}: {title: string; close(): void; children: ReactNode; compact?: boolean; open?: boolean}) {
  const t = useText();
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => { event.preventDefault(); close(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopImmediatePropagation(); dismiss(event); } };
    window.addEventListener('composer-back', dismiss);
    document.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('composer-back', dismiss); document.removeEventListener('keydown', key, true); };
  }, [close, open]);
  return <div style={open ? undefined : {display:'none'}} className="composer-popover-layer" onPointerDown={e => e.preventDefault()} onMouseDown={e => e.preventDefault()} onClick={e => e.stopPropagation()}>
    {/* Dismiss on click, after pointerup, so the same gesture cannot hit the page underneath. */}
    <button className="composer-popover-backdrop" aria-label={t('关闭浮层','Close panel')} onClick={close}/>
    <section className={`composer-popover${compact ? ' compact' : ''}`} role={open ? 'dialog' : undefined} aria-label={title}>
      {!compact && <header className="dialog-header"><h2>{title}</h2><button className="icon-button" aria-label={t('关闭','Close')} onClick={close}><X/></button></header>}
      {children}
    </section>
  </div>;
}
