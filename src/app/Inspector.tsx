// The X-ray panel: for the selected cell, what it reads, what reads it, why it has the value it has,
// and what the engine did on the last recalculation.

import { useMemo } from 'react';
import { addr, colOf, keyAddr, rangeLabel, rowOf, toKey, type CellKey, type Coord, type Range } from '../engine/address.ts';
import type { RecalcReport, Sheet } from '../engine/sheet.ts';
import { displayValue, isError, type CellError, type Scalar } from '../engine/values.ts';
import { highlight } from './formulaTokens.ts';
import type { Change } from './workbook.ts';

interface Props {
  sheet: Sheet;
  version: number;
  active: Coord;
  change: Change | null;
  hint: string | null;
  onDismissHint(): void;
  onJump(c: Coord): void;
}

const fmt = new Intl.NumberFormat('en-US');
const ms = (x: number): string => (x < 1 ? `${x.toFixed(2)} ms` : x < 100 ? `${x.toFixed(1)} ms` : `${Math.round(x)} ms`);

function kindOf(raw: string, v: Scalar): string {
  if (raw === '') return 'Empty';
  if (raw.startsWith('=') && raw.length > 1) return isError(v) ? 'Formula · error' : 'Formula';
  if (typeof v === 'number') return 'Number';
  if (typeof v === 'boolean') return 'Boolean';
  return 'Text';
}

/** Follows an error back through the cells it came from, to the one where it started. */
function traceError(sheet: Sheet, key: CellKey): { origin: CellKey; path: CellKey[] } | null {
  const err = sheet.value(key);
  if (!isError(err)) return null;
  // Inside a loop every cell shares the error, so there is no "where it started".
  if (err.cycle?.includes(key)) return null;
  const path = [key];
  const seen = new Set([key]);
  let cur = key;
  for (let step = 0; step < 200; step++) {
    const { refs, ranges } = sheet.precedentsOf(cur);
    let next: CellKey | null = null;
    for (const r of refs) {
      if (sheet.value(r) === err && !seen.has(r)) {
        next = r;
        break;
      }
    }
    if (next === null) {
      for (const rg of ranges) {
        sheet.forEachOccupied(rg, (v, row, col) => {
          const k = toKey(row, col);
          if (v === err && !seen.has(k)) {
            next = k;
            return true;
          }
          return false;
        });
        if (next !== null) break;
      }
    }
    if (next === null) break;
    seen.add(next);
    path.push(next);
    cur = next;
    // Reached the loop: stop at its edge rather than walking round it.
    if (err.cycle?.includes(next)) break;
  }
  return path.length > 1 ? { origin: cur, path } : null;
}

function Chip({ label, kind, onClick }: { label: string; kind: 'prec' | 'dep' | 'plain'; onClick?: () => void }) {
  return (
    <button type="button" className={`chip chip-${kind}`} onClick={onClick} disabled={!onClick}>
      {label}
    </button>
  );
}

function RecalcSummary({ change, onJump }: { change: Change; onJump(c: Coord): void }) {
  const r: RecalcReport = change.report;
  const skipped = Math.max(0, r.formulas - r.order.length);
  const share = r.formulas ? r.order.length / r.formulas : 0;
  const preview = r.order.slice(0, 14);
  return (
    <section className="ins-section" aria-labelledby="ins-recalc">
      <h3 id="ins-recalc">Last recalculation</h3>
      <p className="ins-lede">
        <strong>{change.label}</strong>
        {r.order.length === 0 ? (
          <> recomputed nothing: no formula depends on it.</>
        ) : (
          <>
            {' '}
            recomputed <strong>{fmt.format(r.order.length)}</strong> of {fmt.format(r.formulas)} formulas in <strong>{ms(r.ms)}</strong>.
          </>
        )}
      </p>
      {r.formulas > 0 && (
        <div className="meter" role="img" aria-label={`${Math.round(share * 100)}% of formulas recomputed`}>
          <div className="meter-on" style={{ width: `${Math.max(share * 100, r.order.length ? 0.8 : 0)}%` }} />
        </div>
      )}
      {r.formulas > 0 && change.kind === 'edit' && (
        <p className="ins-small">
          {skipped > 0 ? `${fmt.format(skipped)} skipped because nothing they read had changed.` : 'Every formula on the sheet was downstream of this change.'}
        </p>
      )}
      {preview.length > 0 && (
        <>
          <h4>Evaluation order</h4>
          <ol className="order">
            {preview.map((k, i) => (
              <li key={k}>
                <button type="button" onClick={() => onJump({ row: rowOf(k), col: colOf(k) })}>
                  <span className="order-n">{i + 1}</span>
                  {keyAddr(k)}
                </button>
              </li>
            ))}
            {r.order.length > preview.length && <li className="order-more">+{fmt.format(r.order.length - preview.length)}</li>}
          </ol>
        </>
      )}
      {r.cycles.length > 0 && (
        <p className="ins-warn">
          {r.cycles.length === 1 ? 'Found a circular reference: ' : `Found ${r.cycles.length} circular references, the first: `}
          {r.cycles[0].slice(0, 8).map(keyAddr).join(' → ')}
          {r.cycles[0].length > 1 ? ` → ${keyAddr(r.cycles[0][0])}` : ''}
        </p>
      )}
    </section>
  );
}

export function Inspector({ sheet, version, active, change, hint, onDismissHint, onJump }: Props) {
  const key = toKey(active.row, active.col);
  const info = useMemo(() => {
    const cell = sheet.cell(key);
    const raw = cell?.raw ?? '';
    const value = cell?.value ?? null;
    const { refs, ranges } = sheet.precedentsOf(key);
    const singles: CellKey[] = [...refs];
    const multi: Range[] = [];
    for (const r of ranges) {
      if (r.r1 === r.r2 && r.c1 === r.c2) singles.push(toKey(r.r1, r.c1));
      else multi.push(r);
    }
    const deps = sheet.dependentsOf(key).sort((a, b) => a - b);
    const downstream = deps.length ? sheet.downstreamCount(key, 2_000_000) : 0;
    const trace = traceError(sheet, key);
    return { raw, value, singles, multi, deps, downstream, trace, parseError: cell?.parseError ?? null };
    // The sheet is mutable; version is what says it changed.
  }, [sheet, key, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const stats = useMemo(() => sheet.graphStats(), [sheet, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const goto = (k: CellKey) => () => onJump({ row: rowOf(k), col: colOf(k) });
  const err = isError(info.value) ? (info.value as CellError) : null;
  const segments = info.raw.startsWith('=') ? highlight(info.raw).segments : null;

  return (
    <aside className="inspector" aria-label="X-ray inspector">
      {hint && (
        <div className="hint" role="note">
          <span className="hint-tag">Try it</span>
          <p>{hint}</p>
          <button type="button" className="hint-x" onClick={onDismissHint} aria-label="Dismiss tip">
            ×
          </button>
        </div>
      )}

      <section className="ins-section ins-cell" aria-labelledby="ins-cell">
        <div className="ins-cell-head">
          <h2 id="ins-cell">{addr(active.row, active.col)}</h2>
          <span className="badge">{kindOf(info.raw, info.value)}</span>
        </div>
        {segments ? (
          <code className="ins-formula">
            {segments.map((s, i) => (
              <span key={i} className={`tok-${s.kind}${s.color !== undefined ? ` ref-${s.color}` : ''}`}>
                {s.text}
              </span>
            ))}
          </code>
        ) : info.raw ? null : (
          <p className="ins-small">This cell is empty. Type to give it a value or a formula.</p>
        )}
        {info.raw !== '' && (
          <div className={`ins-value${err ? ' is-error' : ''}`}>
            <span className="ins-label">Value</span>
            <span className="ins-v">{displayValue(info.value) || '""'}</span>
          </div>
        )}
        {err && (
          <div className="ins-error">
            <p>{err.why}</p>
            {info.trace && err.cycle && (
              <p>
                It comes from the circular reference at{' '}
                <button type="button" className="link" onClick={goto(info.trace.origin)}>
                  {keyAddr(info.trace.origin)}
                </button>
                .
              </p>
            )}
            {info.trace && !err.cycle && (
              <p>
                It started in{' '}
                <button type="button" className="link" onClick={goto(info.trace.origin)}>
                  {keyAddr(info.trace.origin)}
                </button>
                {info.trace.path.length > 2 && <> and reached this cell through {info.trace.path.slice(1, -1).map(keyAddr).join(', ')}</>}.
              </p>
            )}
          </div>
        )}
      </section>

      {(info.singles.length > 0 || info.multi.length > 0) && (
        <section className="ins-section" aria-labelledby="ins-reads">
          <h3 id="ins-reads">
            <span className="dot dot-prec" aria-hidden="true" />
            Reads
          </h3>
          <div className="chips">
            {info.singles.map((k) => (
              <Chip key={k} label={keyAddr(k)} kind="prec" onClick={goto(k)} />
            ))}
            {info.multi.map((r) => (
              <Chip key={rangeLabel(r)} label={rangeLabel(r)} kind="prec" onClick={() => onJump({ row: r.r1, col: r.c1 })} />
            ))}
          </div>
        </section>
      )}

      <section className="ins-section" aria-labelledby="ins-deps">
        <h3 id="ins-deps">
          <span className="dot dot-dep" aria-hidden="true" />
          Read by
        </h3>
        {info.deps.length === 0 ? (
          <p className="ins-small">No formula reads this cell, so changing it recomputes nothing.</p>
        ) : (
          <>
            <div className="chips">
              {info.deps.slice(0, 24).map((k) => (
                <Chip key={k} label={keyAddr(k)} kind="dep" onClick={goto(k)} />
              ))}
              {info.deps.length > 24 && <Chip label={`+${fmt.format(info.deps.length - 24)}`} kind="plain" />}
            </div>
            <p className="ins-small">
              Changing it would recompute <strong>{fmt.format(info.downstream)}</strong> formula{info.downstream === 1 ? '' : 's'} downstream, out of{' '}
              {fmt.format(stats.formulas)}.
            </p>
          </>
        )}
      </section>

      {change && <RecalcSummary change={change} onJump={onJump} />}

      <section className="ins-section ins-engine" aria-labelledby="ins-engine">
        <h3 id="ins-engine">Engine</h3>
        <dl>
          <dt>Cells</dt>
          <dd>{fmt.format(stats.cells)}</dd>
          <dt>Formulas</dt>
          <dd>{fmt.format(stats.formulas)}</dd>
          <dt>Reference edges</dt>
          <dd>{fmt.format(stats.refEdges)}</dd>
          <dt>Range index</dt>
          <dd>
            {fmt.format(stats.ranges)}
            {stats.ranges > 0 && (
              <span className="ins-sub">
                {fmt.format(stats.rangeShapes.bucketed)} bucketed, {fmt.format(stats.rangeShapes.tall)} tall, {fmt.format(stats.rangeShapes.wide)} wide
              </span>
            )}
          </dd>
        </dl>
      </section>
    </aside>
  );
}
