// Share links with no server: the sheet is compressed with the browser's built-in deflate and
// carried in the URL's #fragment, which browsers never send to the host.

import type { SheetDoc } from './workbook.ts';

export const HASH_KEY = 's';

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array, transform: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodeDoc(doc: SheetDoc): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(doc));
  return toBase64Url(await pipe(json, new CompressionStream('deflate-raw')));
}

export async function decodeDoc(text: string): Promise<SheetDoc> {
  const json = new TextDecoder().decode(await pipe(fromBase64Url(text), new DecompressionStream('deflate-raw')));
  const doc = JSON.parse(json) as SheetDoc;
  if (!doc || !Array.isArray(doc.cells)) throw new Error('Not a sheet');
  return {
    name: typeof doc.name === 'string' ? doc.name.slice(0, 80) : 'Shared sheet',
    cells: doc.cells.filter((c) => Array.isArray(c) && typeof c[0] === 'string' && typeof c[1] === 'string'),
    widths: Array.isArray(doc.widths) ? doc.widths.filter((w) => Array.isArray(w) && Number.isFinite(w[0]) && Number.isFinite(w[1])) : undefined,
  };
}

export function readHash(): string | null {
  const m = new RegExp(`[#&]${HASH_KEY}=([A-Za-z0-9_-]+)`).exec(location.hash);
  return m ? m[1] : null;
}
