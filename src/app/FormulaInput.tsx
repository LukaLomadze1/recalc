// A text input with syntax colouring. The input's own text is transparent; a mirror element behind it,
// in the same font, draws the coloured tokens. The caret and selection stay native.

import { useLayoutEffect, useMemo, useRef, type KeyboardEvent, type RefObject } from 'react';
import { highlight } from './formulaTokens.ts';

interface Props {
  value: string;
  inputRef: RefObject<HTMLInputElement | null>;
  className?: string;
  label: string;
  readOnly?: boolean;
  placeholder?: string;
  onChange?(text: string, caret: number): void;
  onCaret?(caret: number): void;
  onKeyDown?(e: KeyboardEvent<HTMLInputElement>): void;
  onFocus?(): void;
  onBlur?(): void;
}

export function FormulaInput(p: Props) {
  const mirror = useRef<HTMLDivElement>(null);
  const { segments } = useMemo(() => highlight(p.value), [p.value]);

  const sync = (): void => {
    const input = p.inputRef.current;
    if (input && mirror.current) mirror.current.scrollLeft = input.scrollLeft;
  };
  useLayoutEffect(sync);

  return (
    <div className={`fi ${p.className ?? ''}`}>
      <div className="fi-mirror" ref={mirror} aria-hidden="true">
        {segments.map((s, i) => (
          <span key={i} className={`tok-${s.kind}${s.color !== undefined ? ` ref-${s.color}` : ''}`}>
            {s.text}
          </span>
        ))}
        {/* Room for the caret at the very end. */}
        <span> </span>
      </div>
      <input
        ref={p.inputRef}
        className="fi-input"
        value={p.value}
        readOnly={p.readOnly}
        placeholder={p.placeholder}
        aria-label={p.label}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        onChange={(e) => {
          p.onChange?.(e.target.value, e.target.selectionStart ?? e.target.value.length);
          sync();
        }}
        onSelect={(e) => {
          p.onCaret?.(e.currentTarget.selectionStart ?? 0);
          sync();
        }}
        onScroll={sync}
        onKeyDown={p.onKeyDown}
        onFocus={p.onFocus}
        onBlur={p.onBlur}
      />
    </div>
  );
}
