// The canvas cannot read CSS, so the grid's colours are read from the CSS custom properties once per
// theme change and passed to the renderer.

export interface Theme {
  gridBg: string;
  line: string;
  lineStrong: string;
  header: string;
  headerInk: string;
  headerActive: string;
  headerActiveInk: string;
  ink: string;
  muted: string;
  accent: string;
  accentSoft: string;
  prec: string;
  dep: string;
  ripple: string;
  error: string;
  formulaMark: string;
  refs: string[];
  cellFont: string;
  headerFont: string;
}

export function readTheme(el: HTMLElement): Theme {
  const cs = getComputedStyle(el);
  const v = (name: string): string => cs.getPropertyValue(name).trim();
  return {
    gridBg: v('--grid-bg'),
    line: v('--line'),
    lineStrong: v('--line-strong'),
    header: v('--header'),
    headerInk: v('--header-ink'),
    headerActive: v('--header-active'),
    headerActiveInk: v('--header-active-ink'),
    ink: v('--ink'),
    muted: v('--muted'),
    accent: v('--accent'),
    accentSoft: v('--accent-soft'),
    prec: v('--prec'),
    dep: v('--dep'),
    ripple: v('--ripple'),
    error: v('--error'),
    formulaMark: v('--formula-mark'),
    refs: Array.from({ length: 8 }, (_, i) => v(`--ref-${i}`)),
    cellFont: `400 12.5px ${v('--font-mono')}`,
    headerFont: `500 11.5px ${v('--font-ui')}`,
  };
}

/** `#rrggbb` or `rgb(…)` with an alpha, for fills derived from stroke colours. */
export function withAlpha(color: string, alpha: number): string {
  if (color.startsWith('#') && color.length === 7) {
    const n = parseInt(color.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const m = /rgba?\(([^)]+)\)/.exec(color);
  if (m) {
    const [r, g, b] = m[1].split(',').map((x) => x.trim());
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}
