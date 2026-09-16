// Lot D (item 4) — "in multitrack, if a segment is selected, the pipeline
// should be done on that specific segment ... if a whole file is selected [in
// Waveform], the pipeline should apply to the whole file."
//
// D1 — the target is decided by the ACTIVE VIEW, never by whichever selection
// was set last: Waveform/Spectral read the active document through
// `resolveRegion` exactly as before (untouched by this module); Multitrack
// reads the SELECTED CLIP, over that clip's span of its OWN source document.
// This module is multitrack's half — `clipPassTarget()` is the one place that
// answers "what does a clip-scoped pass write to", and `beginClipWork` /
// `endClipWork` are the working-copy lifecycle that makes writing to it safe
// (D5) and undoable with the SAME Ctrl+Z the user already has (D6).
//
// D5 (this lot's ruling) — a clip-targeted run NEVER writes the clip's source
// document (another clip may reference it, and a length-changing pass would
// desynchronise them with no metadata anywhere that says a pass changed
// length — see decisions.md's D5 evidence). Instead the pass runs on a FRESH
// working document holding a copy of the clip's source window; the clip is
// re-pointed at it on commit, inside one session gesture.
//
// D6 (this lot's ruling) — because the only thing a clip-targeted pass
// changes in the SESSION is the clip's `documentId`/`offsetSample`/
// `lengthSample`, written through `withSessionGesture`, multitrack's existing
// Ctrl+Z (`undoSession`) reverses it exactly like any other clip edit. The
// document edit itself lives on the working document's own (separate) undo
// stack, reachable from Waveform on that document — never a cross-stack
// entry, per `menuActions.ts`'s "the two stacks never interleave".
//
// Fix round 1 (CRITICAL/HIGH) — TWO independent slots, keyed by host KIND
// ('tool' | 'effect'), matching `App.tsx`'s C5 `hostedTool`/`hostedEffect`
// EXACTLY rather than the single global slot this module shipped with. The
// single-slot design let opening ANY tool (even one that itself never mints a
// working copy, e.g. `edit.transcribe`) discard a DIFFERENT, still-mounted
// host's uncommitted working copy — while that host stayed retained (lot C's
// C1/C2) and fully appliable, with its Apply button silently landing on
// whatever document `endClipWork`'s discard reactivated. See
// `lot-d-report.md`'s "Fix round 1" section for the full reproduction, the
// `activeDocumentId` writer enumeration, and why a per-kind slot plus the
// `App.tsx` drift watcher (`clipWorkTargetId`) closes it — this module cannot
// close it alone, because the vulnerable state is "a MOUNTED dialog whose
// Apply reads the live active document", and only `App.tsx` can unmount it.
import { cloneRegion, createDocument, nextId, type AudioDocument } from '../audio/AudioDocument';
import {
  clampFadePair,
  clipSourceWindow,
  createClip,
  documentClipLength,
  type Clip,
} from '../multitrack/session';
import { useSessionStore } from '../multitrack/sessionStore';
import { withSessionGesture } from '../multitrack/sessionUndo';
import { useAppStore, type SelectionRange } from '../stores/appStore';
import { resolveRegion } from './selectionRegion';

export interface ClipPassTarget {
  clipId: string;
  trackId: string;
  clip: Clip;
  doc: AudioDocument;
  /** DOCUMENT samples, via `resolveRegion` — clamped, never re-derived. */
  start: number;
  end: number;
}

/**
 * Why a clip-scoped pass can be refused, verbatim per `clipPassReason`:
 *  - `not-multitrack` — D1's waveform/spectral arm; unchanged behaviour, no
 *    reason string (nothing is disabled because of it).
 *  - `no-clip` — D2/D2-a: nothing selected in multitrack. A standing
 *    `selectedGap` lands here too (D4), for free: `SessionState` keeps the
 *    two mutually exclusive (a non-empty `selectedClipIds` always clears
 *    `selectedGap`, and vice versa — `sessionStore.ts`'s `setSelectedClips`/
 *    `setSelectedGap`), so a selected gap IS an empty clip selection.
 *  - `multi-clip` — D3: more than one clip selected.
 *  - `orphan-clip` — the selected clip's source document is not open.
 *  - `empty-window` — the clip's resolved source window is empty (its
 *    trimmed offset/length reads nothing from its source, or the source
 *    shrank past it — `clipSourceWindow` is unclamped by design).
 */
export type ClipPassRefusal = 'not-multitrack' | 'no-clip' | 'multi-clip' | 'orphan-clip' | 'empty-window';

/**
 * D1's multitrack arm. In order: the active view, then D2's "nothing
 * selected" (which also catches D3's "more than one" and D4's "a gap"), then
 * whether the selected clip's source document is open, then whether its
 * resolved window is non-empty.
 *
 * The primary is resolved the same way `showEditorView` resolves it
 * (`menuActions.ts`'s "leaving multitrack shows the selected clip"): read
 * `selectedClipId`, not `selectedClipIds[0]` — `SessionState`'s own invariant
 * (`selectedClipId === null` iff the array is empty; a non-null primary is
 * always a member) makes the two agree whenever the array holds exactly one
 * id, which is the only case that reaches this branch.
 */
export function clipPassTarget(): ClipPassTarget | ClipPassRefusal {
  const app = useAppStore.getState();
  if (app.view !== 'multitrack') return 'not-multitrack';

  const { session, selectedClipId, selectedClipIds } = useSessionStore.getState();
  if (selectedClipIds.length === 0) return 'no-clip'; // D2/D2-a, and D4 for free
  if (selectedClipIds.length > 1) return 'multi-clip'; // D3

  const clip =
    selectedClipId === null
      ? null
      : (session.tracks.flatMap((t) => t.clips).find((c) => c.id === selectedClipId) ?? null);
  // Unreachable given the invariant above (length 1 implies a live primary
  // that names one of the array's members) — kept as a total function rather
  // than a non-null assertion, the same discipline `showEditorView` uses.
  if (clip === null) return 'no-clip';
  const track = session.tracks.find((t) => t.clips.some((c) => c.id === clip.id));
  if (track === undefined) return 'no-clip'; // unreachable, same reason as above

  const doc = app.documents.find((d) => d.id === clip.documentId) ?? null;
  if (doc === null) return 'orphan-clip';

  const { start, end } = resolveRegion(doc, clipSourceWindow(clip, doc.sampleRate, session.sampleRate));
  if (end <= start) return 'empty-window';

  return { clipId: clip.id, trackId: track.id, clip, doc, start, end };
}

/** The D2/D3/D4 refusal sentence a disabled row shows, verbatim (X3: none of
 * these are identity values — each names the escape the user actually has).
 * `undefined` for `not-multitrack`: D1's waveform/spectral arm is unchanged
 * behaviour, so nothing here is disabled because of it. */
export function clipPassReason(r: ClipPassRefusal): string | undefined {
  switch (r) {
    case 'no-clip':
      return 'Select a clip to run this on it, or switch to Waveform to run it on the whole file.';
    case 'multi-clip':
      return 'Select a single clip — a pass runs on one clip at a time.';
    case 'orphan-clip':
      return "This clip's source file is closed. Reopen it to run this.";
    case 'empty-window':
      return 'This clip reads nothing from its source file.';
    case 'not-multitrack':
      return undefined;
  }
}

/** R16 — the hosted tools whose pass WRITES the target in place (an
 * in-document edit, as opposed to the five document-PRODUCING rows
 * D2-a excludes — they mint a new document and cannot express a clip-scoped
 * input at all; see `menuActions.ts`'s per-row wiring). Each of these opens
 * through `App.tsx`'s `openTool`, which calls `beginClipWork` with the
 * command id below. */
export const CLIP_WORK_COMMANDS: ReadonlySet<string> = new Set([
  'tempo.match',
  'timing.align',
  'effects.vocalChain',
  'effects.podcastChain',
  'lyrics.align',
]);

/** The effect card's own slot id — it has no command id of its own (one
 * registered command, `effect.<id>`, per registered effect), so `App.tsx`'s
 * `openEffect` calls `beginClipWork` with this constant instead. */
export const EFFECT_CARD_WORK_ID = 'effect.card';

/** Fix round 1 — the two independent slots, matching `App.tsx`'s
 * `hostedTool`/`hostedEffect` (C5). `commandId === EFFECT_CARD_WORK_ID` is
 * the ONLY thing that ever opens the `'effect'` kind; every other id
 * `beginClipWork` is ever called with is the `'tool'` kind, whether or not it
 * is a `CLIP_WORK_COMMANDS` member (a non-member still REPLACES whatever
 * `hostedTool` was showing, per C5's single-tool-slot shape, so its slot must
 * still release — just never the effect's). */
export type ClipWorkKind = 'tool' | 'effect';

function kindOf(commandId: string): ClipWorkKind {
  return commandId === EFFECT_CARD_WORK_ID ? 'effect' : 'tool';
}

interface ClipWorkSlot {
  commandId: string;
  clipId: string;
  workDocId: string;
  restore: {
    activeDocumentId: string | null;
    selection: SelectionRange | null;
    cursorSample: number;
    zoom: { samplesPerPixel: number; scrollSample: number };
  };
  committed: boolean;
  /** The working document's `channels` reference at the last observation —
   * an audio edit (and ONLY an audio edit) replaces this array, never a
   * metadata write (`markDirty`, a rename) — same identity key
   * `EffectDialog.tsx`/`tempoService.ts` already use for "did this actually
   * change the audio". */
  lastChannels: Float32Array[];
  unsubscribe: () => void;
}

let toolSlot: ClipWorkSlot | null = null;
let effectSlot: ClipWorkSlot | null = null;

function slotFor(kind: ClipWorkKind): ClipWorkSlot | null {
  return kind === 'tool' ? toolSlot : effectSlot;
}

function setSlotFor(kind: ClipWorkKind, next: ClipWorkSlot | null): void {
  if (kind === 'tool') toolSlot = next;
  else effectSlot = next;
}

/**
 * Fix round 1 — the non-reactive read `App.tsx`'s drift watcher polls: the
 * live working-document id a still-open slot of this kind wants to be the
 * active document, or `null` when this kind has no open slot at all (either
 * it never minted one — the ordinary case for every command outside
 * multitrack, or a `CLIP_WORK_COMMANDS`/effect-card open with no valid clip
 * target — or its own host already closed it). `App.tsx` compares this
 * against the live `activeDocumentId`: ANY writer of that field other than
 * this module's own (`beginClipWork`'s mint, `endClipWork`'s restore) — see
 * `lot-d-report.md`'s enumeration — can drift it away from a slot's target
 * while the slot's own host stays mounted and appliable, and this is the one
 * signal that lets `App.tsx` close that host before a stale Apply can fire.
 */
export function clipWorkTargetId(kind: ClipWorkKind): string | null {
  return slotFor(kind)?.workDocId ?? null;
}

/**
 * Re-points the clip at the working document once it has actually been
 * edited (a `channels` reference change), inside one session gesture — the
 * `commitMergedClips` shape verbatim: add the new clip, THEN remove the old
 * one (never transiently empty the track), and select the new clip
 * afterwards because removing the old one kills the primary
 * (`reconcileSelection`'s "follow the primary" rule).
 *
 * A captured `clipId` no longer live (the clip was deleted, or a previous
 * call to this function already replaced it — the second edit to an
 * already-repointed working document is a no-op here, matching
 * `commitMergedClips`'s "entries whose members are no longer all present are
 * skipped" skip rule) does nothing but mark the slot committed, exactly as
 * `mergeClips.ts:185-187` documents for the analogous case.
 */
function repointClip(kind: ClipWorkKind): void {
  const current = slotFor(kind);
  if (!current) return;
  const { clipId, workDocId } = current;

  const session = useSessionStore.getState().session;
  let old: Clip | null = null;
  let trackId: string | null = null;
  for (const t of session.tracks) {
    const found = t.clips.find((c) => c.id === clipId);
    if (found) {
      old = found;
      trackId = t.id;
      break;
    }
  }
  const workDoc = useAppStore.getState().documents.find((d) => d.id === workDocId) ?? null;
  if (!old || trackId === null || !workDoc) {
    current.committed = true;
    return;
  }

  const lengthSample = documentClipLength(workDoc, session.sampleRate);
  const { fadeIn, fadeOut } = clampFadePair(old.fadeInSample ?? 0, old.fadeOutSample ?? 0, lengthSample, 'in');
  const next = createClip({
    documentId: workDocId,
    startSample: old.startSample,
    offsetSample: 0,
    lengthSample,
    gainDb: old.gainDb,
    ...(fadeIn > 0 ? { fadeInSample: fadeIn, fadeInCurve: old.fadeInCurve } : null),
    ...(fadeOut > 0 ? { fadeOutSample: fadeOut, fadeOutCurve: old.fadeOutCurve } : null),
  });
  const oldId = old.id;
  const targetTrackId = trackId;

  withSessionGesture('Run pass on clip', () => {
    useSessionStore.getState().addClip(targetTrackId, next);
    useSessionStore.getState().removeClip(oldId);
  });
  useSessionStore.getState().setSelectedClips([next.id]);

  current.committed = true;
}

/**
 * Opens a clip-scoped working copy for `commandId`, or does nothing beyond
 * releasing whatever was open before **of the SAME kind**.
 *
 * (1) `endClipWork(kindOf(commandId))` first, unconditionally — a new slot
 * never opens on top of a stale one OF ITS OWN KIND (matches C5's "opening
 * one replaces the retained one" — `hostedTool` and `hostedEffect` are each
 * single-valued, so a NEW tool always replaces whatever tool was retained,
 * and a NEW effect always replaces whatever effect was retained, but the two
 * kinds never replace each other — fix round 1 closes the CRITICAL cross-kind
 * discard the single-slot design had).
 * (2) Returns unless `commandId` is one of `CLIP_WORK_COMMANDS` or the effect
 * card's id AND `clipPassTarget()` actually resolves a target — a call from
 * Waveform/Spectral, or from multitrack with no valid clip, mints nothing.
 * (3) Captures the four view fields a discard must restore.
 * (4) Mints `Clip Edit N` (the `Merge N`/`Join N` numbering) holding a copy of
 * the clip's source window, and `addDocument`s it — which makes it active AND
 * clears `selection`, so every untouched runner (the six selection-reading
 * runners this lot does not touch) resolves "this working document, whole
 * file" — D1's multitrack arm, expressed in state the runners already read,
 * no runner edited.
 * (5) Subscribes to the working document's `channels` identity and re-points
 * the clip the moment it changes.
 *
 * What this function does NOT do (fix round 1): re-assert that the target is
 * STILL live at the moment of Apply. That is `App.tsx`'s drift watcher's job
 * (`clipWorkTargetId`) — this module cannot unmount a dialog, only React can.
 */
export function beginClipWork(commandId: string): void {
  const kind = kindOf(commandId);
  endClipWork(kind);

  if (!CLIP_WORK_COMMANDS.has(commandId) && commandId !== EFFECT_CARD_WORK_ID) return;
  const target = clipPassTarget();
  if (typeof target === 'string') return;

  const app = useAppStore.getState();
  const restore = {
    activeDocumentId: app.activeDocumentId,
    selection: app.selection,
    cursorSample: app.cursorSample,
    zoom: app.zoom,
  };

  const n = nextId('clipedit').split('-')[1];
  const work = createDocument({
    name: `Clip Edit ${n}`,
    sampleRate: target.doc.sampleRate,
    channels: cloneRegion(target.doc, target.start, target.end),
  });
  useAppStore.getState().addDocument(work);
  const workDocId = work.id;

  const newSlot: ClipWorkSlot = {
    commandId,
    clipId: target.clipId,
    workDocId,
    restore,
    committed: false,
    lastChannels: work.channels,
    unsubscribe: () => {},
  };
  newSlot.unsubscribe = useAppStore.subscribe(() => {
    const cur = useAppStore.getState().documents.find((d) => d.id === workDocId);
    if (!cur || cur.channels === newSlot.lastChannels) return;
    newSlot.lastChannels = cur.channels;
    repointClip(kind);
  });
  setSlotFor(kind, newSlot);
}

/**
 * Releases a clip-work slot — the single release point per kind (Risk 1):
 * `beginClipWork`'s leading call (same kind only, fix round 1), `App.tsx`'s
 * `closeTool` (`'tool'`) / `closeEffect` (`'effect'`) / drift watcher (either,
 * on a stale target), and the App-level unmount safety net (both, via the
 * no-argument overload) all call this, and every one of them is safe to call
 * with no slot open.
 *
 * Unsubscribes FIRST, unconditionally, so a throw below can never strand the
 * listener. An uncommitted slot (the card was dismissed without applying, OR
 * `App.tsx`'s drift watcher is closing an orphaned one) discards the working
 * document.
 *
 * Fix round 1 — the restore of the four captured view fields is now GATED on
 * `stillLive`: `activeDocumentId` still naming THIS slot's own working
 * document at the moment this runs. A normal close (the card's own ✕) is
 * always `stillLive` (nothing else has touched `activeDocumentId` since this
 * slot opened), so acceptance 6's restore is unaffected. A DRIFTED close
 * (the watcher calling this because something else already redirected
 * `activeDocumentId` elsewhere — a Files-panel row, `primeMultitrackDocTarget`,
 * a landing, any of the writers enumerated in `lot-d-report.md`) is NOT
 * `stillLive`: restoring here would fight whatever legitimately took over,
 * so the working document is simply closed (harmless — `closeDocument` on a
 * document that is not the active one touches nothing else) and the active
 * document/selection/cursor/zoom are left exactly as the drift's own cause
 * set them.
 */
export function endClipWork(kind?: ClipWorkKind): void {
  if (kind === undefined) {
    endClipWork('tool');
    endClipWork('effect');
    return;
  }
  const current = slotFor(kind);
  if (!current) return;
  current.unsubscribe();
  setSlotFor(kind, null);

  if (current.committed) return;

  const stillLive = useAppStore.getState().activeDocumentId === current.workDocId;
  useAppStore.getState().closeDocument(current.workDocId);
  if (!stillLive) return;

  const app = useAppStore.getState();
  if (
    current.restore.activeDocumentId !== null &&
    app.documents.some((d) => d.id === current.restore.activeDocumentId)
  ) {
    app.setActiveDocument(current.restore.activeDocumentId);
  }
  const cur = useAppStore.getState();
  cur.setSelection(current.restore.selection);
  cur.setCursor(current.restore.cursorSample);
  cur.setZoom(current.restore.zoom);
}

/** Test-only: drops both module slots without performing `endClipWork`'s
 * store side effects (no document close, no restore) — mirrors
 * `_resetSessionUndo`'s "reset module state" framing, scoped to THIS module's
 * own bookkeeping rather than to the app/session stores a shared test fixture
 * may already be resetting in its own `beforeEach`. Unsubscribes first, same
 * as `endClipWork`, so a suite that leaves a slot open never hands the next
 * test a stray listener. */
export function _resetClipWork(): void {
  if (toolSlot) {
    toolSlot.unsubscribe();
    toolSlot = null;
  }
  if (effectSlot) {
    effectSlot.unsubscribe();
    effectSlot = null;
  }
}
