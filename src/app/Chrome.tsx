// The parts around the grid: toolbar and menus, status bar, context menu, help dialog, toast.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatNumber } from '../engine/values.ts';
import type { Stats } from './ops.ts';
import type { Example } from './samples.ts';

// ---------------------------------------------------------------------------------------------
// Icons (inline, so there is nothing to load)

const I = {
  undo: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  redo: 'm15 14 5-5-5-5M20 9H9a5 5 0 0 0 0 10h3',
  chevron: 'm6 9 6 6 6-6',
  sun: 'M12 3v2M12 19v2M5 5l1.5 1.5M17.5 17.5 19 19M3 12h2M19 12h2M5 19l1.5-1.5M17.5 6.5 19 5M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  help: 'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
  code: 'm16 18 6-6-6-6M8 6l-6 6 6 6',
};

export function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true" className="logo">
      <rect x="3" y="3" width="26" height="26" rx="6" fill="var(--ink)" />
      <path d="M3 12h26M12 12v17" stroke="var(--grid-bg)" strokeWidth="1.6" opacity=".5" />
      <path d="M17 17.5a4.5 4.5 0 1 1 1.3 3.2" stroke="var(--ripple)" strokeWidth="2.2" fill="none" strokeLinecap="round" />
      <path d="M16.2 21.6l2.3-.8-.6 2.4" stroke="var(--ripple)" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------
// Menus

interface MenuItem {
  label: string;
  hint?: string;
  onSelect(): void;
  disabled?: boolean;
}

function Menu({ label, items, wide }: { label: ReactNode; items: MenuItem[]; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button type="button" className="tb-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label}
        <Icon d={I.chevron} size={14} />
      </button>
      {open && (
        <div className={`menu-pop${wide ? ' wide' : ''}`} role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              <span>{it.label}</span>
              {it.hint && <span className="menu-hint">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface ToolbarProps {
  name: string;
  examples: Example[];
  canUndo: string | null;
  canRedo: string | null;
  xray: boolean;
  dark: boolean;
  onExample(e: Example): void;
  onNew(): void;
  onOpenCSV(): void;
  onExportCSV(): void;
  onShare(): void;
  onUndo(): void;
  onRedo(): void;
  onXray(on: boolean): void;
  onTheme(): void;
  onHelp(): void;
}

export function Toolbar(p: ToolbarProps) {
  return (
    <header className="toolbar">
      <div className="brand">
        <Logo />
        <span className="brand-name">Recalc</span>
        <span className="doc-name" title={p.name}>
          {p.name}
        </span>
      </div>
      <nav className="tb-group" aria-label="Document">
        <Menu
          label="Examples"
          wide
          items={p.examples.map((e) => ({ label: e.title, hint: e.blurb, onSelect: () => p.onExample(e) }))}
        />
        <Menu
          label="File"
          items={[
            { label: 'New sheet', onSelect: p.onNew },
            { label: 'Open CSV…', onSelect: p.onOpenCSV },
            { label: 'Export CSV', onSelect: p.onExportCSV },
            { label: 'Copy share link', hint: 'The sheet travels in the link', onSelect: p.onShare },
          ]}
        />
        <button type="button" className="tb-icon" onClick={p.onUndo} disabled={!p.canUndo} title={p.canUndo ? `Undo (Ctrl+Z)` : 'Nothing to undo'} aria-label="Undo">
          <Icon d={I.undo} />
        </button>
        <button type="button" className="tb-icon" onClick={p.onRedo} disabled={!p.canRedo} title={p.canRedo ? `Redo (Ctrl+Y)` : 'Nothing to redo'} aria-label="Redo">
          <Icon d={I.redo} />
        </button>
      </nav>
      <div className="tb-group tb-right">
        <label className={`xray-toggle${p.xray ? ' on' : ''}`}>
          <input type="checkbox" role="switch" checked={p.xray} onChange={(e) => p.onXray(e.target.checked)} />
          <span className="xray-track" aria-hidden="true">
            <span className="xray-thumb" />
          </span>
          <span>X-ray</span>
        </label>
        <button type="button" className="tb-icon" onClick={p.onTheme} aria-label={p.dark ? 'Switch to light theme' : 'Switch to dark theme'} title="Theme">
          <Icon d={p.dark ? I.sun : I.moon} />
        </button>
        <button type="button" className="tb-icon" onClick={p.onHelp} aria-label="Help and keyboard shortcuts" title="Help">
          <Icon d={I.help} />
        </button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------------------------
// Status bar

const fmt = (n: number): string => (Math.abs(n) >= 1e15 ? formatNumber(n) : new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(n));

export function StatusBar({ summary, stats }: { summary: string; stats: Stats | null }) {
  return (
    <footer className="statusbar">
      <span className="status-summary" aria-live="polite">
        {summary}
      </span>
      {stats && stats.count > 1 && (
        <span className="status-stats">
          {stats.numbers > 0 && (
            <>
              <span>
                Sum <strong>{fmt(stats.sum)}</strong>
              </span>
              <span>
                Average <strong>{fmt(stats.sum / stats.numbers)}</strong>
              </span>
            </>
          )}
          <span>
            Count <strong>{stats.count}</strong>
          </span>
        </span>
      )}
    </footer>
  );
}

// ---------------------------------------------------------------------------------------------
// Context menu

export interface ContextItem {
  label: string;
  hint?: string;
  onSelect(): void;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: ContextItem[]; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    const el = ref.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) });
      el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    }
    const close = (e: Event): void => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', key);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', key);
      window.removeEventListener('blur', onClose);
    };
  }, [x, y, onClose]);
  return (
    <div className="ctx" ref={ref} style={{ left: pos.x, top: pos.y }} role="menu">
      {items.map((it, i) => (
        <div key={i}>
          {it.separator && <hr />}
          <button
            type="button"
            role="menuitem"
            className={it.danger ? 'danger' : ''}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
          >
            <span>{it.label}</span>
            {it.hint && <kbd>{it.hint}</kbd>}
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Help

const SHORTCUTS: Array<[string, string]> = [
  ['Arrows / Tab / Enter', 'Move'],
  ['Shift + arrows', 'Extend the selection'],
  ['Ctrl + arrows', 'Jump to the edge of the data'],
  ['Type, or F2', 'Edit the cell'],
  ['= then click cells', 'Point at references while writing a formula'],
  ['Esc', 'Cancel editing'],
  ['Delete', 'Clear the selection'],
  ['Ctrl + C / X / V', 'Copy, cut, paste (formulas shift, as in Excel)'],
  ['Drag the corner square', 'Fill: copies formulas, continues series'],
  ['Ctrl + D / Ctrl + R', 'Fill down / right'],
  ['Ctrl + Z / Ctrl + Y', 'Undo / redo'],
  ['Ctrl + Shift + = / Ctrl + −', 'Insert / delete rows or columns'],
  ['Double-click a column edge', 'Fit the column to its contents'],
];

export function Help({ onClose, functionCount }: { onClose(): void; functionCount: number }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog ref={ref} className="help" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current?.close()} aria-labelledby="help-title">
      <div className="help-body">
        <h2 id="help-title">A spreadsheet engine, written from scratch</h2>
        <p>
          Recalc parses formulas with its own parser, tracks which cells read which in a dependency graph, and recomputes only what
          an edit can affect, in dependency order. It has {functionCount} functions and the same grid size as Excel: 1,048,576 rows
          by 16,384 columns.
        </p>
        <p>
          <strong>X-ray</strong> shows the engine at work: arrows to what the selected cell reads (blue) and what reads it
          (orange), and after every edit, the recomputed cells light up in the order they were evaluated.
        </p>
        <h3>Keyboard</h3>
        <table>
          <tbody>
            {SHORTCUTS.map(([k, v]) => (
              <tr key={k}>
                <th scope="row">
                  <kbd>{k}</kbd>
                </th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="help-foot">
          Nothing leaves your browser: sheets are saved in this browser, and a share link carries the sheet inside the link itself.
        </p>
        <form method="dialog">
          <button type="submit" className="btn-primary">
            Got it
          </button>
        </form>
      </div>
    </dialog>
  );
}

export function Toast({ text }: { text: string | null }) {
  return (
    <div className={`toast${text ? ' show' : ''}`} role="status" aria-live="polite">
      {text}
    </div>
  );
}
