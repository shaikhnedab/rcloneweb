import React, { useCallback, useState, useSyncExternalStore } from 'react';
import { AnimatedDialog, AnimatedDialogContent } from '../components/ui/animated-dialog/animated-dialog';
import AnimatedSwitch from '../components/ui/animated-switch/animated-switch';
import { FluidTooltipGroup, FluidTooltipRoot, FluidTooltipTrigger, FluidTooltipContent } from '../components/ui/fluid-tooltip/fluid-tooltip';

/** Tooltip group + labeled trigger for icon-only buttons. Keeps the native
 *  `title` as a fallback; the fluid surface adds directional motion and
 *  works for keyboard focus and touch where titles never appear. */
export function Tip({ id, label, side, children }: {
  id: string; label: string; side?: 'top' | 'right' | 'bottom' | 'left';
  children: React.ReactElement;
}) {
  return (
    <FluidTooltipRoot id={id} side={side}>
      <FluidTooltipTrigger asChild>{children}</FluidTooltipTrigger>
      <FluidTooltipContent>{label}</FluidTooltipContent>
    </FluidTooltipRoot>
  );
}

export { FluidTooltipGroup };

// ---------- icons (stroke-based, 1.6px, feather style) ----------
const PATHS: Record<string, React.ReactNode> = {
  box: <g><path d="M21 8l-9-5-9 5v8l9 5 9-5z" /><path d="M3 8l9 5 9-5" /><path d="M12 13v8" /></g>,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  edit: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" /></>,
  trash: <><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6M14 11v6" /></>,
  folder: <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z" />,
  cloud: <path d="M17.5 19a4.5 4.5 0 000-9 6 6 0 00-11.6 1.6A4 4 0 006.5 19z" />,
  play: <path d="M7 4l13 8-13 8z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="1.5" />,
  download: <><path d="M12 3v12" /><path d="M7 11l5 5 5-5" /><path d="M4 20h16" /></>,
  copy: <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 012-2h10" /></>,
  eye: <><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z" /><circle cx="12" cy="12" r="2.7" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></>,
  save: <><path d="M5 3h11l5 5v11a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z" /><path d="M8 3v5h7" /><path d="M7 14h10v6H7z" /></>,
  sun: <><circle cx="12" cy="12" r="4.5" /><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" /></>,
  moon: <path d="M20 14.5A8.5 8.5 0 019.5 4 8.5 8.5 0 1020 14.5z" />,
  server: <><rect x="3" y="4" width="18" height="7" rx="1.5" /><rect x="3" y="13" width="18" height="7" rx="1.5" /><path d="M7 7.5h.01M7 16.5h.01" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></>,
  link: <><path d="M10 14a5 5 0 007.5.5l2-2A5 5 0 0012.5 5.5l-1 1" /><path d="M14 10a5 5 0 00-7.5-.5l-2 2A5 5 0 0011.5 18.5l1-1" /></>,
  bell: <><path d="M18 9a6 6 0 10-12 0c0 6-2.5 7.5-2.5 7.5h17S18 15 18 9" /><path d="M10.3 20a2 2 0 003.4 0" /></>,
  settings: <><circle cx="12" cy="12" r="3.2" /><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.9 2.9l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.2a1.7 1.7 0 00-1-1.5 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.9-2.9l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.2a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.9-2.9l.1.1a1.7 1.7 0 001.9.3h.1a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.2a1.7 1.7 0 001 1.5h.1a1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.9 2.9l-.1.1a1.7 1.7 0 00-.3 1.9v.1a1.7 1.7 0 001.5 1h.2a2 2 0 110 4h-.2a1.7 1.7 0 00-1.5 1z" /></>,
  grid: <><rect x="3" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" /></>,
  terminal: <><path d="M4 17l6-5-6-5" /><path d="M12 19h8" /></>,
  code: <><path d="M8 6l-6 6 6 6" /><path d="M16 6l6 6-6 6" /></>,
  wrench: <path d="M14.7 6.3a4.5 4.5 0 00-6 5.6L3 17.6V21h3.4l5.7-5.7a4.5 4.5 0 005.6-6L14.5 12l-2.5-2.5z" />,
  check: <path d="M4.5 12.5l5 5 10-11" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  up: <><path d="M12 19V5" /><path d="M5.5 11.5L12 5l6.5 6.5" /></>,
  alert: <><path d="M12 3l10 17H2z" /><path d="M12 10v4" /><path d="M12 17.5h.01" /></>,
  refresh: <><path d="M21 4v6h-6" /><path d="M3 20v-6h6" /><path d="M20 10a8 8 0 00-14.5-3.5L3 9" /><path d="M4 14a8 8 0 0014.5 3.5L21 15" /></>,
  logout: <><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></>,
  zap: <path d="M13 2L4.5 13.5H11L10 22l8.5-11.5H12z" />,
};

export function Icon({ name, size = 16, className }: { name: keyof typeof PATHS | string; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      {PATHS[name] ?? null}
    </svg>
  );
}

// ---------- toast queue ----------
export interface ToastItem { id: number; msg: string; err: boolean }
let toastSeq = 0;
let toasts: ToastItem[] = [];
const toastListeners = new Set<() => void>();
function emitToasts() { toastListeners.forEach((l) => l()); }
export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emitToasts();
}
export function toast(msg: string, err = false) {
  const id = ++toastSeq;
  toasts = [...toasts.slice(-3), { id, msg, err }];
  emitToasts();
  setTimeout(() => dismissToast(id), err ? 5000 : 2800);
}
export function ToastHost() {
  const items = useSyncExternalStore(
    (cb) => { toastListeners.add(cb); return () => toastListeners.delete(cb); },
    () => toasts,
  );
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.err ? 'toast-err' : 'toast-ok'}`}>
          <Icon name={t.err ? 'alert' : 'check'} size={14} />
          <span>{t.msg}</span>
          <button className="toast-x" aria-label="Dismiss" onClick={() => dismissToast(t.id)}><Icon name="x" size={12} /></button>
        </div>
      ))}
    </div>
  );
}

// ---------- modal primitive ----------
export function Modal({ onClose, children, width = 520 }: { title: string; onClose: () => void; children: React.ReactNode; width?: number }) {
  // Single seam: every dialog (VPS, destination, browse, confirm, prompt,
  // alert) renders through here, so all of them get the animated dialog's
  // direction-aware motion plus Base UI focus trapping and Escape handling.
  // Our .dlg-card tokens are kept via className — visuals are unchanged.
  return (
    <AnimatedDialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <AnimatedDialogContent
        from="bottom"
        className="dlg-card"
        style={{ width, maxWidth: 'calc(100vw - 40px)' }}
        onBackdropClick={onClose}
      >
        {children}
      </AnimatedDialogContent>
    </AnimatedDialog>
  );
}

export interface DialogSpec {
  title: string; message?: string; danger?: boolean; okText?: string;
  input?: string; placeholder?: string;
  resolve: (v: unknown) => void;
}

export function useDialog() {
  const [open, setOpen] = useState<DialogSpec | null>(null);
  const [inputVal, setInputVal] = useState('');
  const show = useCallback((spec: DialogSpec) => {
    setInputVal(spec.input ?? '');
    setOpen(spec);
  }, []);
  const confirm = useCallback((title: string, message = '', okText = 'OK', danger = false) =>
    new Promise<boolean>((res) => show({ title, message, okText, danger, resolve: res as never })), [show]);
  const prompt = useCallback((title: string, message = '', def = '', placeholder = '') =>
    new Promise<string | null>((res) => show({ title, message, okText: 'Save', input: def, placeholder, resolve: res as never })), [show]);
  const alert = useCallback((title: string, message = '') =>
    new Promise<void>((res) => show({ title, message, okText: 'Close', resolve: () => res() })), [show]);

  const settle = (v: unknown) => { open?.resolve(v); setOpen(null); };
  const isPrompt = open?.input !== undefined;
  const dlg = open ? (
    <Modal title={open.title} onClose={() => settle(isPrompt ? null : false)} width={440}>
      <h3 className="dlg-title">{open.title}</h3>
      {open.message && <p className="dlg-message">{open.message}</p>}
      {isPrompt && (
        <form onSubmit={(e) => { e.preventDefault(); settle(inputVal); }}>
          <input
            className="dlg-input" value={inputVal} placeholder={open.placeholder}
            onChange={(e) => setInputVal(e.target.value)} autoFocus aria-label={open.title}
          />
        </form>
      )}
      <div className="dlg-actions">
        <button className="btn ghost" onClick={() => settle(isPrompt ? null : false)}>Cancel</button>
        <button className={`btn filled ${open.danger ? 'btn-danger' : ''}`} onClick={() => settle(isPrompt ? inputVal : true)}>{open.okText || 'OK'}</button>
      </div>
    </Modal>
  ) : null;
  return { dlg, confirm, prompt, alert };
}

/** Labeled on/off row backed by the animated switch. Keeps the legacy
 *  .check-row layout; the switch itself is keyboard-operable with a real
 *  label (no bare checkbox). */
export function SwitchRow({ label, hint, checked, onChange, title }: {
  label: React.ReactNode; hint?: React.ReactNode; checked: boolean;
  onChange: (v: boolean) => void; title?: string;
}) {
  return (
    <label className="check-row" title={title}>
      <AnimatedSwitch size="sm" checked={checked} onCheckedChange={onChange} aria-label={typeof label === 'string' ? label : undefined} />
      <span>{label} {hint}</span>
    </label>
  );
}

/** Small labeled field wrapper. */
export function Field({ label, children, grow, hint }: { label: string; children: React.ReactNode; grow?: boolean; hint?: string }) {
  return (
    <label className={`field ${grow ? 'grow' : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />;
}
