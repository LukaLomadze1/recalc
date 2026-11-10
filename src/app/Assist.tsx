// The popover under whichever input is being edited: function completions while typing a name, and
// the signature of the function the caret is inside, with the current argument in bold.

import type { FnDef } from '../engine/functions.ts';

interface Props {
  anchor: DOMRect | null;
  completions: FnDef[] | null;
  active: number;
  call: { fn: FnDef; arg: number } | null;
  onPick(fn: FnDef): void;
}

export function Assist({ anchor, completions, active, call, onPick }: Props) {
  if (!anchor || (!completions && !call)) return null;
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - 380));
  // Below the input if there is room, otherwise above it.
  const below = anchor.bottom + 240 < window.innerHeight;
  const style = below ? { left, top: anchor.bottom + 4 } : { left, bottom: window.innerHeight - anchor.top + 4 };
  if (completions) {
    return (
      <ul className="assist assist-list" style={style} role="listbox" aria-label="Function suggestions">
        {completions.map((f, i) => (
          <li
            key={f.name}
            role="option"
            aria-selected={i === active}
            className={i === active ? 'on' : ''}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(f);
            }}
          >
            <span className="assist-name">{f.name}</span>
            <span className="assist-desc">{f.desc}</span>
          </li>
        ))}
        <li className="assist-foot" aria-hidden="true">
          Tab to insert
        </li>
      </ul>
    );
  }
  const { fn, arg } = call!;
  const parts = fn.args ? fn.args.split(', ') : [];
  // Repeating arguments ("number1, [number2], …") keep the last named one highlighted.
  const repeats = parts[parts.length - 1] === '…';
  const hi = repeats && arg >= parts.length - 1 ? parts.length - 2 : arg;
  return (
    <div className="assist assist-sig" style={style} role="tooltip">
      <div className="sig-line">
        <span className="assist-name">{fn.name}</span>(
        {parts.map((a, i) => (
          <span key={i}>
            {i > 0 && ', '}
            <span className={i === hi ? 'sig-arg on' : 'sig-arg'}>{a}</span>
          </span>
        ))}
        )
      </div>
      <div className="assist-desc">{fn.desc}</div>
    </div>
  );
}
