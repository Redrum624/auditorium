import type { FadeCurve } from '../dsp/fades';

/** In-app audio clipboard: a single module-level slot holding the channel data
 * and source sample rate of the most recent cut/copy. It is deliberately
 * separate from the OS clipboard (which only carries text/images). */
export interface ClipboardData {
  channels: Float32Array[];
  sampleRate: number;
}

/**
 * Lot L (L4a) — one clipboard, two mutually exclusive payload SHAPES, the
 * exclusion enforced HERE rather than by every caller.
 *
 * `Ctrl+C`/`Ctrl+V` are one keyboard row each (`shortcuts.ts:20-21`, `ctrl+c`
 * -> `edit.copy`, `ctrl+v` -> `edit.paste`) and one registry command each,
 * live in every view — the user has no way to see which of two invisible
 * slots a press would hit, so a copy in one shape must retire the other
 * rather than leave a stale payload a later paste could silently reach. The
 * exclusion lives inside the two setters (never in a caller) so `editOps.ts`'s
 * `cutSelection`/`copySelection` need no edit at all to stay correct: the one
 * place that could break the invariant is the one place that owns it.
 *
 * Rejected: (a) two independently-cleared slots — a multitrack `Ctrl+V` could
 * then paste a document region copied minutes earlier in the editor, with
 * nothing on screen to say the clip clipboard was never touched; (b) baking a
 * copied clip selection to PCM into the existing `ClipboardData` slot at copy
 * time — it would bake gain and fades in, make Copy an O(audio) act, and
 * throw away the non-destructive clip model `pastedClipGeometry`
 * (`multitrack/clipClipboard.ts`) depends on.
 *
 * Consequence (stated because it is a behaviour change, X1): copying clips in
 * multitrack now empties the audio clipboard, so Paste in Waveform/Spectral
 * greys with its own reason (`PASTE_HOLDS_CLIPS_REASON`,
 * `multitrack/clipClipboard.ts`) — pinned in `clipboard.test.ts` and
 * `menuActions.mtClipboard.test.ts`.
 */
export interface ClipboardClipEntry {
  documentId: string;
  /** Track offset from the topmost SOURCE track, 0 for it. */
  trackOffset: number;
  /** Offset from the earliest copied clip's `startSample`, at `sampleRate`
   * (the source session's rate) — always >= 0. */
  startOffsetSample: number;
  /** The source DOCUMENT's own samples — `session.ts:187-197`'s
   * `clipSourceWindow` is the proof this never converts on paste. */
  offsetSample: number;
  lengthSample: number;
  gainDb: number;
  fadeInSample?: number;
  fadeOutSample?: number;
  fadeInCurve?: FadeCurve;
  fadeOutCurve?: FadeCurve;
}

export interface ClipboardClips {
  entries: ClipboardClipEntry[];
  /** The SOURCE SESSION's rate — never a document's — so a paste into a
   * session at another rate can compute `ratio = session.sampleRate /
   * payload.sampleRate` (`pastedClipGeometry`). */
  sampleRate: number;
}

let clipboard: ClipboardData | null = null;
let clipClipboard: ClipboardClips | null = null;

/** Stores a defensive copy of the channel data so later edits to the source
 * document cannot mutate what a subsequent paste will insert. Retires the
 * clip clipboard (L4a). */
export function setClipboard(data: ClipboardData): void {
  clipboard = {
    channels: data.channels.map((ch) => ch.slice()),
    sampleRate: data.sampleRate,
  };
  clipClipboard = null;
}

/** Returns the stored clipboard (by reference — callers must not mutate it) or
 * null when nothing has been cut/copied yet. */
export function getClipboard(): ClipboardData | null {
  return clipboard;
}

/** Stores a defensive copy of the entry list (L4a) and retires the audio
 * clipboard. */
export function setClipClipboard(v: ClipboardClips): void {
  clipClipboard = { entries: v.entries.map((e) => ({ ...e })), sampleRate: v.sampleRate };
  clipboard = null;
}

/** Returns the stored clip clipboard (by reference — callers must not mutate
 * it) or null when nothing has been copied yet. */
export function getClipClipboard(): ClipboardClips | null {
  return clipClipboard;
}

/** Which shape the clipboard currently holds, or `null` when empty. The one
 * predicate every reason string (`PASTE_EMPTY_REASON` /
 * `PASTE_HOLDS_AUDIO_REASON` / `PASTE_HOLDS_CLIPS_REASON`,
 * `multitrack/clipClipboard.ts`) is derived from. */
export function getClipboardKind(): 'audio' | 'clips' | null {
  if (clipboard !== null) return 'audio';
  if (clipClipboard !== null) return 'clips';
  return null;
}

/** Empties the clipboard. Primarily a test-isolation hook. Clears BOTH slots
 * (L4a) — a test that resets one and not the other would leave
 * `getClipboardKind()` lying about which shape is live. */
export function clearClipboard(): void {
  clipboard = null;
  clipClipboard = null;
}
