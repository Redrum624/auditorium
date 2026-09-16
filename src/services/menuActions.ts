import { createDocument, docLength, nextId, type AudioDocument } from '../audio/AudioDocument';
import type { AppState, Marker } from '../stores/appStore';
import { applyEditorZoom, useAppStore } from '../stores/appStore';
import {
  applySessionZoom,
  closeGap, // D3
  hasAnyClip, // lot E
  removeClips,
  rippleDeleteClips,
  silenceClipsInRange, // lot J
  splitClipsAt,
  splitTargets,
  trimClipsToRange, // lot J
  useSessionStore,
} from '../multitrack/sessionStore';
import { silenceTargets, trimTargets } from '../multitrack/timeRange'; // lot J
import { clipBoundaries, nextClipEdge } from '../multitrack/clipEdges'; // K1
import { sessionEndSample } from '../multitrack/sessionZoom'; // T5
import { sessionLaneWidth } from '../multitrack/sessionViewport'; // T5
import { clipSourceWindow } from '../multitrack/session'; // lot E
import { resolveRegion } from './selectionRegion'; // lot E
import { editorLaneWidth } from './editorViewport'; // lot E
import { placeDocumentsOnTrack } from '../multitrack/sessionInsert';
import { mixdownSession } from '../multitrack/mixdown';
import { bakeMergedClip, commitMergedClips, mergeTargets } from '../multitrack/mergeClips';
import { canRecord, transportPlayPause, transportRecord, transportStop } from './transportService';
import { multitrackRecorder } from '../multitrack/multitrackRecord';
import {
  cutSelection,
  copySelection,
  pasteAtCursor,
  deleteSelection,
  pushMarkerUndo,
  rippleDeleteSelection,
  silenceSelection,
  splitAtCursor,
  trimToSelection,
} from './editOps';
import { cursorSegment } from './segments';
import { canRedo, canUndo, redo, undo } from './undoHistory';
import { canRedoSession, canUndoSession, redoSession, undoSession } from '../multitrack/sessionUndo';
import { getClipboard, getClipboardKind } from './clipboard';
// Lot L (items 11/12) — the multitrack clip clipboard's verbs (the slot
// itself lives in `./clipboard`).
import {
  copySelectedClips,
  pasteBlockReason,
  pasteClipsAtCursor,
  PASTE_HOLDS_CLIPS_REASON,
} from '../multitrack/clipClipboard';
import { closeDocumentFlow, openFilesViaDialog, projectHasUnsavedWork } from './fileService';
import { openSessionViaDialog, saveProject } from '../multitrack/sessionFile';
import {
  openConvertDialog,
  openEffectDialog,
  openExportDialog,
  openNewFileDialog,
  openRemixDialog,
  openSeparateDialog,
  openTranscribeDialog,
  openVoiceChangerDialog,
  openTempoDialog,
  openAlignLyricsDialog,
  openAlignTimingDialog,
  openVocalChainDialog,
  openCoverChainDialog,
  openPodcastChainDialog,
  focusSpatialPanel,
  focusTranscriptPanel,
} from './dialogBus';
import { getTranscript } from './transcribeService';
import { getVisibleEffects } from '../effects/EffectRegistry';
import { captureNoiseProfile } from './noiseProfile';
import { toggleSpectralScale } from './spectralScale';
import { toggleBeatGrid } from './beatGridDisplay';
import { toggleSnap } from './snapPreference';
import { runTempoAnalysis } from './tempoAnalysis';
// ---- lot M ----
// Item 13 / M1/M3/M4: the app-wide single-pass lock. A leaf module — see
// passLock.ts's own header for why it is safe to import from here.
import {
  PASS_REFUSED,
  blockedByPassReason,
  closeBlockedReason,
  closeFree,
  isPassRunning,
  runExclusivePass,
} from './passLock';
// ---- /lot M ----
// ---- lot D ----
// Item 4 (D1) — the target-resolution rule for multitrack: `clipPassTarget()`
// is the ONE place that answers "what document/window does a clip-scoped
// pass act on"; `clipPassReason` is its refusal sentence (D2/D3/D4).
import { clipPassReason, clipPassTarget } from './clipPass';
// ---- /lot D ----

export interface MenuCommand {
  id: string;
  label: string;
  shortcut?: string;
  enabled(s: AppState): boolean;
  /**
   * Lot M — an optional reason a DISABLED command is disabled, read against
   * the live store exactly like `enabled`. `undefined` means "no reason to
   * show" (an enabled command, or a disabled one with nothing worth saying
   * beyond the greyed-out state). Shared with lots D2/D3, J and L3/L5: the
   * field is added ONCE, here; a later-landed lot's own reasons compose onto
   * the same field rather than inventing a second one.
   */
  reason?(s: AppState): string | undefined;
  run(): void | Promise<void>;
}

export interface MenuSection {
  /** F11-7: 'Pipeline' widens what had been a five-title closed union.
   *
   * Plan Ruling 5 said NOT to widen it "for a handful of analysis/transform
   * commands", and every command that wanted a home since has been argued into
   * Effects or Edit against that ruling. The user has overruled it: those
   * commands live in a top-level Pipeline menu now. The ruling is kept on
   * the record here rather than deleted — it was a real constraint, the
   * decisions it produced are all over this file's comments, and it stopped
   * applying by request rather than by being wrong. */
  title: 'File' | 'Edit' | 'Effects' | 'Pipeline' | 'View' | 'Help';
  items: (MenuCommand | 'separator')[];
}

/** Module-level command registry, keyed by id. `registerCommands` overwrites by id
 * so later tasks can replace a stub registered here without duplicating entries. */
const registry = new Map<string, MenuCommand>();

export function registerCommands(cmds: MenuCommand[]): void {
  for (const cmd of cmds) {
    registry.set(cmd.id, cmd);
  }
}

export async function runCommand(id: string): Promise<void> {
  const cmd = registry.get(id);
  if (!cmd) return;
  if (!cmd.enabled(useAppStore.getState())) return;
  await cmd.run();
}

/**
 * Whether a registered command would run right now — the command's OWN
 * predicate, read against the live store, so no second surface has to restate
 * a rule the menu already owns. An unregistered id is disabled, matching
 * `fallbackCommand` (and `runCommand`, which silently no-ops on one).
 *
 * U1: added for the E2 edit toolbar's per-button greying. The Edit menu reads
 * `item.enabled(...)` directly off the section it was handed; a toolbar holds
 * ids, not commands, and this is the honest way to ask the same question.
 */
export function isCommandEnabled(id: string): boolean {
  const cmd = registry.get(id);
  return cmd !== undefined && cmd.enabled(useAppStore.getState());
}

/**
 * Lot M (M3) — the reason a DISABLED command is disabled, or `null` for an
 * unregistered id or one that is currently enabled. Every gated surface reads
 * this rather than composing its own sentence, so the tooltip and any future
 * refusal always say the same thing the registry itself would.
 */
export function commandReason(id: string): string | null {
  const cmd = registry.get(id);
  if (!cmd) return null;
  if (cmd.enabled(useAppStore.getState())) return null;
  return cmd.reason?.(useAppStore.getState()) ?? null;
}

// ---- lot M ----
/** True when no long-running pass holds the app-wide lock — the ONE gate
 * every pass-start command's `enabled` predicate ANDs in (M1/M4). */
function passFree(): boolean {
  return !isPassRunning();
}

/** The ONE reason string every pass-gated command shows (M3) — `undefined`
 * (not `null`) so it fits `MenuCommand.reason`'s return type directly. */
function passReason(): string | undefined {
  return blockedByPassReason() ?? undefined;
}

/**
 * Fix round 1 (item 6) — `closeFree`'s actual policy now lives ONCE, in
 * `passLock.ts` (`closeFree`/`closeBlockedReason`), because `FilesPanel.tsx`'s
 * row ✕ needs the identical question answered and cannot route through
 * `file.close` itself (that command always closes the ACTIVE document; a row
 * can close any OTHER open one). This is the thin adapter fitting that shared
 * answer to `MenuCommand.reason`'s `string | undefined` shape — see
 * `passLock.ts`'s own docblock for the full argument.
 */
function closeReason(): string | undefined {
  return closeBlockedReason() ?? undefined;
}
// ---- /lot M ----

// ---- lot D ----
/**
 * D1 — whether a command that acts on "the document" has a valid target:
 * waveform/spectral read the active document (unchanged — D1's non-multitrack
 * arm); multitrack reads the single selected clip via `clipPassTarget()`
 * (D2/D3/D4's refusals collapse to "no target" here).
 */
function hasPassTarget(s: AppState): boolean {
  return s.view === 'multitrack' ? typeof clipPassTarget() !== 'string' : activeDoc(s) !== null;
}

/**
 * The D2/D3/D4 refusal sentence for a command with no pass target — PURE
 * (no pass-lock knowledge), matching the formula decisions.md/the brief state
 * verbatim. `undefined` outside multitrack: D1's arm there is unchanged
 * behaviour, so there is nothing new to say. Used directly by `noise.capture`,
 * whose `enabled` does not gate on the pass lock at all (M-d: synchronous,
 * mouse-only, never in lot M's start-path table) — composing `passReason()`
 * into IT would show a "pass running" tooltip on a row whose disablement has
 * nothing to do with the lock. Every OTHER gated row reads `pipelineReason`
 * below instead, which composes the two.
 */
function passTargetReason(s: AppState): string | undefined {
  if (s.view !== 'multitrack') return undefined;
  const target = clipPassTarget();
  return typeof target === 'string' ? clipPassReason(target) : undefined;
}

/**
 * Reason precedence, composing lot D with lot M (Risk 2's "the precedence
 * rule lives in `commandReason`, not in six surfaces" — every UI surface
 * reads `commandReason(id)` and trusts what comes back rather than composing
 * either reason itself; this is the one place that composition happens).
 * A pass already RUNNING is the more urgent, app-wide fact — it blocks every
 * pass-start door, not just this one — and a missing TARGET is only
 * actionable once that pass ends, so the busy reason is checked first. Used
 * by every row whose `enabled` also gates on `passFree()`: `effect.<id>`,
 * `tempo.detect`, `tempo.match`, `timing.align`, `effects.vocalChain`,
 * `effects.podcastChain`, `lyrics.align`.
 */
function pipelineReason(s: AppState): string | undefined {
  return passReason() ?? passTargetReason(s);
}

/**
 * R16 — the document one of the five whole-document, document-PRODUCING rows
 * (`edit.separateStems`, `voice.separate`, `edit.transcribe`, `edit.remix`,
 * `edit.voiceChanger`) targets. D2-a excludes these from `hasPassTarget`'s
 * disabling (they mint a NEW document and cannot express "over that clip's
 * span" — D1's window has nothing for them to absorb), but excluding them
 * from DISABLING is not the same as excluding them from the WRONG-DOCUMENT
 * defect: their dialogs resolve their input from `activeDocumentId`
 * (unchanged by this lot — see each dialog's own `activeDoc` selector), and
 * in multitrack that id is whatever was last active, which is not
 * necessarily the SELECTED CLIP's own source document.
 *
 * In multitrack, prefers the selected clip's source document
 * (`clipPassTarget()`'s `.doc` — the input `clipPassTarget()` resolves, never
 * its window: these five cannot express a sub-document span) when one
 * resolves; falls back to the active document otherwise — unchanged
 * behaviour with no clip selected (D2-a's exemption: these five keep working
 * right where a landing like `stemLanding.ts` leaves the user, with no clip
 * selected and the freshly landed document active) or with an ambiguous
 * selection (`multi-clip`/`orphan-clip`/`empty-window` — these five were
 * never clip-aware before this lot, and D2-a did not ask them to start
 * refusing on a selection they cannot act on anyway). Outside multitrack,
 * identical to today: the active document, D1's arm unchanged.
 *
 * Fix round 1 (finding 5) — also `tempo.detect`'s own document resolution
 * (folded into this shared function rather than a duplicate inline copy) and
 * `TempoCard.tsx`'s: that card used to show the ACTIVE document's tempo entry
 * unconditionally, which drifted from what a multitrack `tempo.detect` click
 * would actually analyse the moment R16 wiring landed — a stale-parallel-
 * variable defect (the exact class lot M spent a round removing). Exported so
 * both can read the same answer to "which document does tempo.detect mean".
 */
export function multitrackToolDoc(s: AppState): AudioDocument | null {
  if (s.view === 'multitrack') {
    const target = clipPassTarget();
    if (typeof target !== 'string') return target.doc;
  }
  return activeDoc(s);
}

/**
 * R16 — call at the TOP of one of the five rows' `run()`, before the dialog
 * opens. Makes the selected clip's source document active first (mirroring
 * `showEditorView`'s identical "activate first, and only when it actually
 * differs" guard — no gratuitous `activationReset` when it is already
 * active), so the dialog's own `activeDocumentId` read resolves to the clip
 * the user selected rather than whatever was active before. A no-op outside
 * multitrack or with no resolvable clip target — see `multitrackToolDoc`'s
 * docblock for when that is.
 *
 * Fix round 1 (finding 6) — exported so `TranscriptPanel.tsx`'s two
 * "Transcribe again…" buttons can call it too. Those bypass the command
 * registry entirely (`openTranscribeDialog()` directly — lot M's own report
 * names this "the one surviving registry bypass", kept deliberately for
 * `App.tsx`'s `refuseWhileRunning` defence in depth), so without this they
 * never got R16's wiring: in multitrack they would open the dialog against
 * whatever was merely active, the exact wrong-document defect R16 exists to
 * close for the other five doors.
 */
export function primeMultitrackDocTarget(): void {
  const target = clipPassTarget();
  if (typeof target === 'string') return;
  const app = useAppStore.getState();
  if (app.activeDocumentId !== target.doc.id) app.setActiveDocument(target.doc.id);
}

/** D1 — `effects.coverChain`'s own multitrack refusal (verbatim, X3: not an
 * identity value). See that command's own docblock for why it is disabled
 * outright rather than gated on a clip target. */
const COVER_CHAIN_MULTITRACK_REASON =
  'Cover Chain builds a session of its own — switch to Waveform to run it.';
// ---- /lot D ----

/** Fixed section/item layout. Ids are resolved against the registry live at
 * `getMenuSections()` call time, so registering a command after this module
 * loads (e.g. a later task replacing a stub) is reflected immediately. */
const LAYOUT: { title: MenuSection['title']; itemIds: (string | 'separator')[] }[] = [
  {
    title: 'File',
    itemIds: [
      'file.new',
      'file.open',
      // T4: Record. This command was in NO section, which made the Record
      // dialog the one dialog in the app a menu-only user could not open —
      // its doors were the transport bar's button and nothing else. Filed
      // here, after Open, because New / Open / Record are the three ways audio
      // gets in front of you; File already carries a non-`file.*` id on the
      // same principle (`multitrack.mixdown` makes material too).
      //
      // The label stays 'Record' with no ellipsis. The row opens a dialog in
      // the waveform/spectral views but punches straight in on the armed
      // tracks in the multitrack view (transportService.transportRecord), so
      // an ellipsis would be a promise it breaks half the time.
      'transport.record',
      'file.save',
      'file.saveAs',
      'file.export',
      // lot A (M4): `session.save` is folded into Save As — no duplicate rows.
      'session.open',
      'multitrack.mixdown',
      'separator',
      'file.close',
    ],
  },
  {
    title: 'Edit',
    itemIds: [
      'edit.undo',
      'edit.redo',
      'separator',
      // Item 8 (M1): Split at Cursor is the row before Cut — the verb that
      // makes the segments Ctrl+X then cuts.
      'edit.split',
      // D6: Split's inverse, the row directly after it — the verb that cuts a
      // clip in two and the verb that makes two clips one read together.
      // H1 (lot H): "Merge Clips" renamed "Join Clips" everywhere the user
      // can see it; the id follows the label.
      'multitrack.joinClips',
      'edit.cut',
      'edit.copy',
      'edit.paste',
      'edit.delete',
      // K1: the same verb with the gap closed behind it. Directly after
      // Delete, because that is the row a user comparing the two reads next.
      'edit.rippleDelete',
      // T5: and the range form of it, listed and permanently greyed — see the
      // command's own note for why it cannot be built yet.
      'edit.rippleDeleteTime',
      // M1: Trim and Silence act on the same `[start, end)` selection as the
      // four above and share Cut's predicate, so they belong in that group
      // rather than behind a separator of their own. Until now the floating
      // edit toolbar was their only surface — mouse-reachable and nowhere
      // else, so anyone who looked for them where every other edit verb lives
      // found nothing. Neither carries a shortcut label: neither has a combo
      // in SHORTCUT_TABLE, and this repo has just paid for two labels that
      // named keys doing nothing.
      'edit.trim',
      'edit.silence',
      'separator',
      'edit.selectAll',
      'separator',
      'edit.convertSampleRate',
      'edit.convertChannels',
      // F11-7: the long-inference group that sat here — Auto-Remix, Separate
      // into Stems, Transcribe, Voice Changer — moved to the Pipeline section
      // below, taking its separator with it so this list keeps one separator
      // between each surviving group.
      'separator',
      'multitrack.insertDoc',
      'multitrack.addTrack',
      // K1: cursor navigation over the session's edit points. Filed with the
      // multitrack group rather than with the markers below, because these two
      // exist only in that view and the marker pair exists only outside it.
      'multitrack.prevClipEdge',
      'multitrack.nextClipEdge',
      'separator',
      'marker.add',
      'marker.next',
      'marker.prev',
    ],
  },
  { title: 'Effects', itemIds: ['effects.none'] },
  {
    // F11-7. Ten advanced tools, MOVED here — six out of the Effects menu's
    // head (Detect Tempo, Match Tempo, Align Vocal Timing, Align Lyrics, Vocal
    // Chain, Cover Chain) and four out of the Edit menu's long-inference group
    // (Auto-Remix, Separate into Stems, Transcribe, Voice Changer). Nothing
    // about the commands themselves changed: same ids, same predicates, same
    // run bodies, same (absent) shortcuts. Only where the user finds them.
    // F11-8 then ADDED an eleventh that was moved from nowhere — the Spatial
    // Positioner — and T8 moved that one OUT again, to the Effects menu, on
    // the user's direction ("move the Spacial tool to the effects module").
    // Ten rows again; count the list below, not this sentence.
    //
    // The groups are by SUBJECT, which is a deliberate change of basis.
    // The Effects head listed Align Vocal Timing → Align Lyrics → Vocal Chain
    // in RUN order, and each of those stages' notes argued its own position;
    // grouping by subject puts Align Lyrics at the end of Voice instead, so the
    // menu no longer encodes sequence. The stage notes in `vocalChain.ts` and
    // `coverChain.ts` remain the surface that does, and each one names the
    // menu path to run it from — those strings moved with this section.
    title: 'Pipeline',
    itemIds: [
      // Tempo & Timing — everything that answers "this is not in time".
      'tempo.detect',
      'tempo.match',
      'timing.align',
      'edit.remix',
      'separator',
      // Voice — everything that reshapes a vocal take.
      // D7: Separate Voice OPENS the group. Isolating the voice precedes
      // reshaping it, so every row below operates on what it produced — the
      // one place this menu still says anything about order, and it says it
      // by subject ("first you get the voice on its own") rather than by run
      // sequence.
      'voice.separate',
      'edit.voiceChanger',
      'effects.vocalChain',
      'effects.coverChain',
      // D7: the Podcast Chain follows the Cover Chain, closing the run of
      // multi-stage passes before Align Lyrics.
      'effects.podcastChain',
      'lyrics.align',
      'separator',
      // Analysis — whole-file model runs that produce new material.
      'edit.transcribe',
      'edit.separateStems',
      // F11-8 closed this list with a fourth group, Mix, holding
      // `spatial.position`. T8 moved that command to the Effects section (see
      // `effectsSectionItemIds`), taking its separator with it — three groups.
    ],
  },
  {
    title: 'View',
    itemIds: [
      'view.waveform',
      'view.spectral',
      'view.spectralScale',
      'view.beatGrid',
      'view.snapToGrid',
      'view.multitrack',
    ],
  },
  { title: 'Help', itemIds: ['help.about'] },
];

/** Placeholder for any id referenced by LAYOUT but not (yet) registered. */
function fallbackCommand(id: string): MenuCommand {
  return { id, label: id, enabled: () => false, run: async () => {} };
}

/** Builds the Effects section's item ids live from the registry: a disabled
 * category-label item for each `EffectCategory`, followed by that category's
 * effects (both category and effect commands are registered by
 * `registerEffectCommands`). Falls back to the `effects.none` stub until any
 * effect is registered. */
function effectsSectionItemIds(): (string | 'separator')[] {
  const effects = getVisibleEffects();
  if (effects.length === 0) {
    return ['noise.capture', 'separator', 'effects.none', 'separator', 'spatial.position'];
  }
  // F11-7: the six analysis/transform commands that used to head this list
  // (Detect Tempo, Match Tempo…, Align Vocal Timing…, Align Lyrics…, Vocal
  // Chain…, Cover Chain…) were here only because Plan Ruling 5 forbade a menu
  // of their own. They are in the Pipeline section now and the menu is plain
  // registry effects again.
  //
  // 'Capture Noise Print' is the one that stayed, and it is a ruling rather
  // than an oversight. It is not one of the ten the user moved; it is an
  // instant profile of the current selection rather than a multi-stage pass;
  // and its only consumer is the Noise Reduction EFFECT a few rows below it —
  // its own confirmation dialog sends the user straight there. Moving it would
  // file a one-step primer under a menu of long jobs and separate it from the
  // only thing it primes.
  const ids: (string | 'separator')[] = ['noise.capture', 'separator'];
  let lastCategory: string | null = null;
  for (const e of effects) {
    if (e.category !== lastCategory) {
      ids.push(`effects.cat.${e.category}`);
      lastCategory = e.category;
    }
    ids.push(`effect.${e.id}`);
  }
  // T8: the Spatial Positioner closes this menu as its own Mix group, moved
  // here from the Pipeline section's fourth group on the user's direction
  // ("move the Spacial tool to the effects module"). It is appended in BOTH
  // branches so its door does not depend on the effect registry having
  // populated. Not an `effect.<id>` row — it is a command that focuses the
  // persistent SpatialPanel, and converting it would change what it does.
  ids.push('separator');
  ids.push('spatial.position');
  return ids;
}

export function getMenuSections(): MenuSection[] {
  return LAYOUT.map((section) => {
    const itemIds = section.title === 'Effects' ? effectsSectionItemIds() : section.itemIds;
    return {
      title: section.title,
      items: itemIds.map((id) =>
        id === 'separator' ? 'separator' : (registry.get(id) ?? fallbackCommand(id))
      ),
    };
  });
}

function stub(id: string, label: string, shortcut?: string): MenuCommand {
  return { id, label, shortcut, enabled: () => false, run: async () => {} };
}

/** Registers the File/Edit/View/Effects stub commands plus the working Help >
 * About command. Idempotent: re-running just overwrites the same ids with the
 * same values (registerCommands overwrites by id). Later tasks call
 * registerCommands() again to replace individual stubs with real behavior. */
function registerDefaultCommands(): void {
  registerCommands([
    stub('file.new', 'New', 'Ctrl+N'),
    stub('file.open', 'Open…', 'Ctrl+O'),
    stub('file.save', 'Save', 'Ctrl+S'),
    stub('file.saveAs', 'Save As…', 'Ctrl+Shift+S'),
    stub('file.export', 'Export…'),
    stub('file.close', 'Close', 'Ctrl+W'),

    stub('edit.undo', 'Undo', 'Ctrl+Z'),
    stub('edit.redo', 'Redo', 'Ctrl+Y'),
    stub('edit.cut', 'Cut', 'Ctrl+X'),
    stub('edit.copy', 'Copy', 'Ctrl+C'),
    stub('edit.paste', 'Paste', 'Ctrl+V'),
    stub('edit.delete', 'Delete', 'Del'),
    stub('edit.selectAll', 'Select All', 'Ctrl+A'),

    stub('effects.none', 'No effects loaded'),

    stub('view.waveform', 'Waveform'),
    stub('view.spectral', 'Spectral'),
    stub('view.multitrack', 'Multitrack'),

    {
      id: 'help.about',
      label: 'About Auditorium',
      enabled: () => true,
      run: async () => {
        const api = window.electronAPI;
        if (!api) return;
        const version = await api.getAppVersion();
        // The stem-separation attribution lives here as well as in the README
        // (v1.7 ruling 9). It is appended to `message` rather than passed as
        // `detail` because the main process's message-box validator whitelists
        // type/title/message/buttons and drops everything else.
        await api.showMessageBox({
          type: 'info',
          title: 'About Auditorium',
          message:
            `Auditorium\nVersion ${version}\n\n` +
            'Stem separation uses HT-Demucs (Meta AI, MIT), via the StemSplitio ONNX export.',
        });
      },
    },
  ]);
}

function activeDoc(s: AppState) {
  return s.documents.find((d) => d.id === s.activeDocumentId) ?? null;
}

/** Registers the selection/transport commands driven by keyboard shortcuts
 * (Task 8). `edit.selectAll`, `edit.deselect`, `transport.goToStart` and
 * `transport.goToEnd` are implemented against the store now; the rest of
 * transport and `marker.add` remain disabled stubs until their owning tasks
 * (9, 23) land. Overwrites the `edit.selectAll` stub registered above. */
function registerSelectionAndTransportCommands(): void {
  registerCommands([
    {
      // T5 view routing (the `edit.delete` shape): Ctrl+A selects whatever the
      // visible surface has to select. In the multitrack view that is every
      // CLIP on every track — the document region behind it is not on screen,
      // which is the same argument `edit.deselect` below already makes, and
      // until now the key reached a command gated on an active document and so
      // did nothing in that view at all.
      id: 'edit.selectAll',
      label: 'Select All',
      shortcut: 'Ctrl+A',
      enabled: (s) => (s.view === 'multitrack' ? hasAnyClip(useSessionStore.getState().session) : activeDoc(s) !== null),
      run: async () => {
        if (useAppStore.getState().view === 'multitrack') {
          const { session, setSelectedClips } = useSessionStore.getState();
          setSelectedClips(session.tracks.flatMap((t) => t.clips.map((c) => c.id)));
          return;
        }
        const { documents, activeDocumentId, setSelection } = useAppStore.getState();
        const doc = documents.find((d) => d.id === activeDocumentId);
        if (!doc) return;
        setSelection({ start: 0, end: docLength(doc) });
      },
    },
    {
      // K1 view routing (the `edit.delete` shape): Escape clears whatever the
      // visible surface calls a selection. In the multitrack view that is the
      // clip selection — the document region behind it is not on screen, and
      // clearing it there was the same invisible edit F1 gated cut/copy/paste
      // out of that view for.
      id: 'edit.deselect',
      label: 'Deselect',
      shortcut: 'Esc',
      // D3: the multitrack's selection is now a clip selection OR a gap, so
      // Escape answers for both. It is not the only way out — since review
      // round 1 (I3) a plain press on empty lane space clears the band too,
      // except a press INSIDE the band's own span on its own lane, which is
      // the first half of the double-click that would re-select it. Escape is
      // the way out that works from anywhere, including from inside that span.
      //
      // Lot J: a standing TIME RANGE arms it too, and Escape clears that as
      // well — the third kind of multitrack "selection" this menu action now
      // answers for.
      enabled: (s) =>
        s.view === 'multitrack'
          ? useSessionStore.getState().selectedClipId !== null ||
            useSessionStore.getState().selectedGap !== null ||
            useSessionStore.getState().mtTimeRange !== null
          : s.selection !== null,
      run: async () => {
        if (useAppStore.getState().view === 'multitrack') {
          useSessionStore.getState().setSelectedClip(null);
          useSessionStore.getState().setSelectedGap(null);
          useSessionStore.getState().setMtTimeRange(null);
          return;
        }
        useAppStore.getState().setSelection(null);
      },
    },
    {
      // T5 — view-routed like the pair below it. Both keys were gated on an
      // active DOCUMENT and wrote the editor's cursor, so in the multitrack
      // view Home and End did nothing (K1 noticed it while auditing the keymap
      // and left it out of scope). Enabled with NO clips as well: sample 0 is
      // where an empty session's cursor belongs just as much, and unlike the
      // clip-edge keys there is always somewhere to go.
      id: 'transport.goToStart',
      label: 'Go to Start',
      shortcut: 'Home',
      enabled: (s) => (s.view === 'multitrack' ? true : activeDoc(s) !== null),
      run: async () => {
        if (useAppStore.getState().view === 'multitrack') {
          const { mtZoom, setMtCursor } = useSessionStore.getState();
          setMtCursor(0);
          // Through `applySessionZoom`, the session's one clamped writer, for
          // the reason the editor arm below states: a second raw `setMtZoom`
          // caller is how a clamp stops being single-sourced.
          applySessionZoom({ samplesPerPixel: mtZoom.samplesPerPixel, scrollSample: 0 });
          return;
        }
        // F11 fix round (I2): through the one clamped writer. `scrollSample: 0`
        // is already legal at every zoom, so this is about routing rather than
        // about the value — a second `setZoom` caller is how the clamp stopped
        // being single-sourced the first time.
        useAppStore.getState().setCursor(0);
        applyEditorZoom({ samplesPerPixel: useAppStore.getState().zoom.samplesPerPixel, scrollSample: 0 });
      },
    },
    {
      // T5 — "the end" of a SESSION is the end of its last clip, across every
      // track (`sessionEndSample`, the same number the zoom's fit is stated
      // in). Gated on `hasAnyClip` rather than on the view alone: with no
      // clips the end IS the start, and a key that lands where the cursor
      // already is should say so by being disabled, exactly as the clip-edge
      // pair does.
      id: 'transport.goToEnd',
      label: 'Go to End',
      shortcut: 'End',
      enabled: (s) => (s.view === 'multitrack' ? hasAnyClip(useSessionStore.getState().session) : activeDoc(s) !== null),
      run: async () => {
        if (useAppStore.getState().view === 'multitrack') {
          const { session, mtZoom, setMtCursor } = useSessionStore.getState();
          const end = sessionEndSample(session);
          setMtCursor(end);
          // THE END AT THE RIGHT EDGE, asked for as a function of the resolved
          // zoom rather than as `scrollSample: end`. The editor arm below can
          // ask for `len` because its own clamp is `maxScroll` and pins the
          // document's end to the right edge for it; the session's scrollable
          // extent runs MT_TIMELINE_TAIL_SEC past the last clip, so the same
          // request here would NOT clamp — it would park the end at the LEFT
          // edge with a minute of emptiness beside it, which is the off-screen
          // destination the editor's own End key was fixed for. The floor at 0
          // for a session narrower than the lane is `resolveSessionZoom`'s, not
          // a second clamp here.
          applySessionZoom({
            samplesPerPixel: mtZoom.samplesPerPixel,
            scrollSample: (spp) => end - sessionLaneWidth() * spp,
          });
          return;
        }
        const { documents, activeDocumentId, zoom, setCursor } = useAppStore.getState();
        const doc = documents.find((d) => d.id === activeDocumentId);
        if (!doc) return;
        const len = docLength(doc);
        setCursor(len);
        // F11 fix round (I2): asking for `len` and letting the store clamp it
        // to `maxScroll` puts the END of the document at the right edge, which
        // is what "Go to End" means. The previous version wrote the unclamped
        // `len` straight into the store and called the resulting over-scroll
        // "self-correcting", on the grounds that the next wheel gesture would
        // fix it — which left the tics and the ruler drawn past the end of the
        // audio until the user happened to scroll. It also cited an onWheel
        // clamp that no longer exists; `resolveZoom` owns both clamps now.
        applyEditorZoom({ samplesPerPixel: zoom.samplesPerPixel, scrollSample: len });
      },
    },

    {
      // View-routed: the multitrack view plays via the MultitrackPlayer, the
      // waveform/spectral view via the single-document PlaybackEngine. The
      // dispatch lives in transportService so the command id stays stable.
      id: 'transport.playPause',
      label: 'Play/Pause',
      shortcut: 'Space',
      enabled: (s) => s.view === 'multitrack' || activeDoc(s) !== null,
      run: async () => transportPlayPause(),
    },
    {
      id: 'transport.stop',
      label: 'Stop',
      enabled: (s) => s.view === 'multitrack' || activeDoc(s) !== null,
      run: async () => transportStop(),
    },
    {
      id: 'transport.toggleLoop',
      label: 'Loop',
      enabled: (s) => activeDoc(s) !== null,
      run: async () => {
        const { playback, setPlayback } = useAppStore.getState();
        setPlayback({ loop: !playback.loop });
      },
    },
    {
      // View-routed: the multitrack view punches into armed tracks; the
      // waveform/spectral views open the Record dialog. Enablement AND the
      // toggle/dispatch live in transportService (canRecord/transportRecord)
      // so the menu and the transport Toolbar share one source of truth.
      id: 'transport.record',
      label: 'Record',
      // Fix round 1 (item 5b) — overturns M-d's original exclusion. A
      // recording — in either view — ends with `addDocument`, minting a new
      // ACTIVE document exactly like `file.new`/`file.open` do; the user's
      // own words ("never run more than one pipeline or PROCESS at a time")
      // name a recording as one. M-d's reasoning still holds for keeping the
      // RUNNING session itself unlocked (RecordDialog is a modal, so
      // `hasOpenDialog()`'s stack already excludes every other pass-start
      // while it is open) — only STARTING one is gated here. The
      // `multitrackRecorder.isRecording()` clause keeps the multitrack
      // punch-in STOP transition reachable unconditionally — this command
      // is that button's only door (Toolbar.tsx), and a take already in
      // progress must always be stoppable, lock or no lock.
      enabled: () => canRecord() && (multitrackRecorder.isRecording() || passFree()),
      reason: passReason,
      run: async () => transportRecord(),
    },
    stub('marker.add', 'Add Marker', 'M'),
    stub('marker.next', 'Next Marker'),
    stub('marker.prev', 'Previous Marker'),
  ]);
}

/** Registers the real destructive-edit and undo/redo commands (Task 10),
 * overwriting the disabled stubs. cut/copy/delete need an active doc + a
 * selection; paste needs an active doc + a non-empty clipboard; undo/redo are
 * gated on the active document's history stacks. */
function registerEditCommands(): void {
  const hasSelection = (s: AppState) => activeDoc(s) !== null && s.selection !== null;

  /**
   * F1: the five REGION verbs — cut, copy, paste, trim, silence — act on a
   * region of the ACTIVE DOCUMENT, which the multitrack view does not show.
   * `setView` does not clear the selection (deliberately: coming back to
   * Waveform should find your work where you left it), so in that view each of
   * them addressed a document the user cannot see, with no feedback anywhere in
   * the session, while the Undo beside them routes to the SESSION's history and
   * cannot undo a document edit.
   *
   * Gated here rather than per surface, so the toolbar, the Edit menu and the
   * keyboard inherit one rule — `runCommand` re-checks `enabled` before running,
   * which is what makes the accelerators inert too.
   *
   * This CHANGES pre-existing behaviour: Ctrl+X/C/V in the multitrack view used
   * to edit the hidden document silently. That was the same trap with no button
   * on it, not a feature worth preserving.
   *
   * `edit.delete` is deliberately NOT in this set — it already routes to clip
   * removal in the multitrack view, so it is view-aware by design.
   */
  const isDocumentEditView = (s: AppState) => s.view !== 'multitrack';
  const canEditRegion = (s: AppState) => isDocumentEditView(s) && hasSelection(s);
  registerCommands([
    {
      // R3 view routing (ruling 1), same shape as edit.delete below: in the
      // multitrack view Ctrl+Z addresses the SESSION's history; in the
      // waveform/spectral editors it addresses the active document's. The
      // two stacks never interleave — that is the per-document convention
      // multi-document editors already follow, extended to the session.
      id: 'edit.undo',
      label: 'Undo',
      shortcut: 'Ctrl+Z',
      enabled: (s) =>
        s.view === 'multitrack'
          ? canUndoSession()
          : s.activeDocumentId !== null && canUndo(s.activeDocumentId),
      run: async () => {
        if (useAppStore.getState().view === 'multitrack') {
          undoSession();
          return;
        }
        const id = useAppStore.getState().activeDocumentId;
        if (id) undo(id);
      },
    },
    {
      id: 'edit.redo',
      label: 'Redo',
      shortcut: 'Ctrl+Y',
      enabled: (s) =>
        s.view === 'multitrack'
          ? canRedoSession()
          : s.activeDocumentId !== null && canRedo(s.activeDocumentId),
      run: async () => {
        if (useAppStore.getState().view === 'multitrack') {
          redoSession();
          return;
        }
        const id = useAppStore.getState().activeDocumentId;
        if (id) redo(id);
      },
    },
    {
      id: 'edit.split',
      label: 'Split at Cursor',
      shortcut: 'Ctrl+K',
      // M1: one view-routed command - a marker at the cursor in the editors,
      // a clip split at the edit cursor in the multitrack (M2/N1-N5, see the
      // `canSplitAtMtCursor` region below).
      enabled: (s) => (s.view === 'multitrack' ? canSplitAtMtCursor() : activeDoc(s) !== null),
      run: async () => {
        if (useAppStore.getState().view === 'multitrack') {
          splitSelectedTracksAtMtCursor();
          return;
        }
        splitAtCursor();
      },
    },
    {
      id: 'edit.cut',
      label: 'Cut',
      shortcut: 'Ctrl+X',
      // Item 8 (M1/N9): with no selection, Ctrl+X cuts the segment the cursor
      // is in, so it is live whenever there is a selection OR an interior
      // marker to bound one. Still never in multitrack (M7).
      enabled: (s) =>
        isDocumentEditView(s) &&
        activeDoc(s) !== null &&
        (s.selection !== null || cursorSegment(s) !== null),
      run: async () => cutSelection(),
    },
    // Lot L (items 11/12) — narrows the M7/F1 gate for these two verbs ONLY.
    // F1's argument was that all five region verbs edit a region of the
    // ACTIVE DOCUMENT, which the multitrack view does not show, and whose
    // Undo (routed to the session) cannot reverse. That argument no longer
    // applies to Copy/Paste once a clip clipboard exists (L1-L5): the
    // multitrack arm addresses the SESSION — the surface on screen, whose
    // history the neighbouring Undo already routes to — exactly the same
    // narrowing lot J made for Trim/Silence just above. Cut stays on
    // `isDocumentEditView` (M7, unchanged) — L1 names Copy and Paste only.
    {
      id: 'edit.copy',
      label: 'Copy',
      shortcut: 'Ctrl+C',
      enabled: (s) => (s.view === 'multitrack' ? canCopyClips() : canEditRegion(s)),
      reason: (s) =>
        s.view === 'multitrack' && !canCopyClips() ? 'select a clip first' : undefined,
      run: async () => {
        if (useAppStore.getState().view === 'multitrack') {
          copySelectedClips();
          return;
        }
        copySelection();
      },
    },
    {
      id: 'edit.paste',
      label: 'Paste',
      shortcut: 'Ctrl+V',
      enabled: (s) =>
        s.view === 'multitrack'
          ? pasteBlockReason() === undefined
          : isDocumentEditView(s) && activeDoc(s) !== null && getClipboard() !== null,
      reason: (s) =>
        s.view === 'multitrack'
          ? pasteBlockReason()
          : getClipboardKind() === 'clips'
            ? PASTE_HOLDS_CLIPS_REASON
            : undefined,
      run: async () => {
        if (useAppStore.getState().view === 'multitrack') {
          pasteClipsAtCursor();
          return;
        }
        pasteAtCursor();
      },
    },
    {
      // In the multitrack view, Delete removes the selected clip; elsewhere it
      // silences the selected region in place at constant length (item 7;
      // Task 22 view routing).
      //
      // K1: "the selected clip" is now "the selection", which may hold several
      // clips across several tracks. The predicate is unchanged — the set is
      // empty exactly when the primary is null — and a single-clip delete is
      // byte-for-byte the act it always was (`removeClips` keeps the label and
      // takes the same path); what changed is that a Ctrl+Click set goes in one
      // undo entry rather than needing one Delete per clip.
      id: 'edit.delete',
      label: 'Delete',
      shortcut: 'Del',
      // D3: a GAP arms it too, and closes instead of removing. The store keeps
      // the two selections mutually exclusive, so this reads the gap first and
      // never has to arbitrate.
      //
      // Lot M — deliberately NOT gated on `passFree()`. This is an EDIT, not a
      // pass-start (M1 does not name it), and it is already reachable via
      // mouse during a background pass today — `EditToolbar.tsx`'s Delete
      // button reads only `isCommandEnabled('edit.delete')`, with no
      // `hasOpenDialog`/`toolRunning` check anywhere in that file or here.
      // M6 removing the blanket keyboard suspension makes the bare `d`
      // shortcut match that pre-existing mouse behaviour, not a new hazard —
      // gating every mutating command was considered and rejected (M-c).
      // The lot-H bare letter is intended to fire mid-pass exactly like the
      // toolbar button already does; whatever the running pass is writing to
      // is protected by ITS OWN staleness/cancel-ref guard, not by this gate.
      enabled: (s) =>
        s.view === 'multitrack'
          ? useSessionStore.getState().selectedClipId !== null ||
            useSessionStore.getState().selectedGap !== null
          : hasSelection(s),
      run: async () => {
        if (useAppStore.getState().view === 'multitrack') {
          const gap = useSessionStore.getState().selectedGap;
          if (gap !== null) {
            closeGap(gap);
            return;
          }
          removeClips(useSessionStore.getState().selectedClipIds);
          return;
        }
        deleteSelection();
      },
    },
    {
      // K1 R3 — Audition's Ripple Delete: remove the selected clip(s) AND close
      // the gap, so everything later on each affected track moves up. Deleting
      // a bad take out of the middle of an arrangement is the reason it exists;
      // plain Delete leaves the hole.
      //
      // Item 7 (N8): view-routed like Delete. In the editor views it is the
      // pre-item-7 Delete — remove the selection and close the gap, the one
      // editor edit besides Trim that shortens the file — now that plain
      // Delete silences the span in place at constant length.
      id: 'edit.rippleDelete',
      label: 'Ripple Delete',
      shortcut: 'Shift+Del',
      // D3: same arming, same act. Closing a gap IS the ripple's second half
      // (remove nothing, close the hole), so the two verbs deliberately agree
      // rather than inventing a second meaning for a span that is empty
      // already — `menuActions.gaps.test.ts` pins that they land the same
      // session.
      enabled: (s) =>
        s.view === 'multitrack'
          ? useSessionStore.getState().selectedClipId !== null ||
            useSessionStore.getState().selectedGap !== null
          : hasSelection(s),
      run: async () => {
        if (useAppStore.getState().view === 'multitrack') {
          const gap = useSessionStore.getState().selectedGap;
          if (gap !== null) {
            closeGap(gap);
            return;
          }
          rippleDeleteClips(useSessionStore.getState().selectedClipIds);
          return;
        }
        rippleDeleteSelection();
      },
    },
    {
      /**
       * T5 — RIPPLE DELETE OF A TIME RANGE: listed, and disabled everywhere.
       *
       * Lot J (item 10) BUILT the range-sweep gesture this note used to say
       * did not exist — a promise the code no longer kept is a documentation
       * defect (R26), so this is rewritten rather than left stale. The
       * multitrack view NOW has a time range (`Shift`+drag a lane;
       * `SessionState.mtTimeRange`), and `edit.silence` above is its
       * NON-RIPPLING form: it clears the range on the scoped tracks and
       * leaves the hole, exactly like plain Delete leaves a gap
       * (`menuActions.ts`'s own `edit.delete`, and `sessionStore.closeGap`
       * for the single-gap case).
       *
       * WHAT IS ACTUALLY MISSING is narrower than "no gesture": a RIPPLING
       * time-range delete needs its own scope and shift semantics that were
       * never specified —
       *  - which tracks shift: every track in the session regardless of
       *    scope (a ripple is inherently cross-track — item 13's phrasing,
       *    "remove that span from ALL tracks and close the gap everywhere"),
       *    or only `mtRangeScopeTrackIds()`'s selection-scoped set (J2's own
       *    rule for the non-rippling verbs)?
       *  - whether a track the range does not touch at all (no clip
       *    overlapping it) still shifts, the same "gap is bounded on both
       *    sides" question `gaps.ts`'s own header answers for the single-gap
       *    case but which a MULTI-track ripple has never had to answer.
       * `mergeSpans` and the shift loop in `rippleDeleteClips` are still the
       * whole computation once those two questions have rulings — this verb
       * is unblocked by lot J but not thereby specified.
       *
       * NO ACCELERATOR, deliberately: `installShortcuts` claims a matched combo
       * before it consults `enabled`, so a key bound here would be swallowed in
       * every view and hand nothing back.
       *
       * The reason is NOT surfaced as a tooltip. A `title` on a disabled button
       * is not reliably shown in Chromium, and this repo does not ship
       * affordances it has not seen work — the USER_GUIDE carries the sentence
       * instead.
       */
      id: 'edit.rippleDeleteTime',
      label: 'Ripple Delete Time Selection',
      enabled: () => false,
      run: async () => {},
    },
    // U1: `trimToSelection` and `silenceSelection` have existed in editOps
    // since Task 22 with no command in front of them — the Edit menu never
    // listed them, so the only way to reach either was the test hooks. The E2
    // edit toolbar puts a button on each, and the app's rule is that a button
    // calls a COMMAND: the registry is what re-checks enablement at run time,
    // so a surface can never outrun it. Neither op is touched. Same
    // `hasSelection` predicate as Cut/Copy, which is what both functions
    // already require and return early without.
    // M1: both are in the Edit menu's LAYOUT too now, next to Delete — U1 left
    // the menu alone as out of its scope, which left the toolbar their only
    // surface.
    // H5 (lot H): each now has a real bare-letter combo in SHORTCUT_TABLE
    // (`T`, `S`), so each advertises it — the "neither gets a `shortcut`"
    // note above was true only while neither had a bound key; leaving the
    // label off now would be the same dead-accelerator defect this repo has
    // already paid for twice (Ctrl+W, Ctrl+Shift+S).
    //
    // Lot J (item 10) — VIEW-ROUTED, in `edit.split`'s own shape above. This
    // OVERTURNS F1's five-verb set (`isDocumentEditView`/`canEditRegion`,
    // this file's own note just above them) for these two members ONLY:
    // F1's argument was that Cut/Copy/Paste/Trim/Silence all edit a REGION OF
    // THE ACTIVE DOCUMENT, which the multitrack view does not show and whose
    // Undo (routed to the session) cannot reverse. That argument no longer
    // applies to Trim/Silence once a multitrack time range exists (J1-J9):
    // the multitrack arm edits the SESSION, not the hidden document, and the
    // adjacent Undo already addresses exactly that history
    // (`edit.undo` above routes to `undoSession()` in this view). Cut/Copy/
    // Paste stay on `canEditRegion` — a clip clipboard is lot L's, not this
    // one's — so F1 still governs three of the five.
    {
      id: 'edit.trim',
      label: 'Trim to Selection',
      shortcut: 'T',
      enabled: (s) => (s.view === 'multitrack' ? canTrimMtRange() : canEditRegion(s)),
      run: async () => {
        if (useAppStore.getState().view === 'multitrack') {
          trimMtRange();
          return;
        }
        trimToSelection();
      },
    },
    {
      id: 'edit.silence',
      label: 'Silence Selection',
      shortcut: 'S',
      enabled: (s) => (s.view === 'multitrack' ? canSilenceMtRange() : canEditRegion(s)),
      run: async () => {
        if (useAppStore.getState().view === 'multitrack') {
          silenceMtRange();
          return;
        }
        silenceSelection();
      },
    },
  ]);
}

// ---- lot C ----
// Items 7 and 8 (editor edit verbs). The segment model the `edit.cut`
// predicate and `cutSelection` share lives in `./segments` (`cursorSegment`);
// no helper of this lot lives in this file.
// ---- end lot C ----

/** Registers the real File > * commands (Task 11), overwriting the disabled
 * stubs. New/Open are always available. Lot A (M4): Save / Save As write the
 * `.audm` PROJECT in every view — Save is gated on the project's unsaved
 * work, Save As is always available; Export and Close require an active
 * document (Export in the multitrack view follows the session instead — M5).
 * New and Export open React dialogs via the dialog bus; the rest drive the
 * fileService / sessionFile flows. run() is async so awaits propagate. */
function registerFileCommands(): void {
  const hasDoc = (s: AppState) => activeDoc(s) !== null;
  const activeId = () => useAppStore.getState().activeDocumentId;
  registerCommands([
    {
      id: 'file.new',
      label: 'New',
      shortcut: 'Ctrl+N',
      // M-c: one of the four document-lifecycle doors gated while the pass
      // lock is held — the keyboard-reachable replacement for the F10 guard
      // M6 removes (a new document could become the one a running pass is
      // pinned to, and the pass's own commit resolves it live).
      enabled: () => passFree(),
      reason: passReason,
      run: async () => openNewFileDialog(),
    },
    {
      id: 'file.open',
      label: 'Open…',
      shortcut: 'Ctrl+O',
      enabled: () => passFree(),
      reason: passReason,
      run: async () => {
        await openFilesViaDialog();
      },
    },
    {
      id: 'file.save',
      label: 'Save',
      shortcut: 'Ctrl+S',
      // Lot A (M4): Save writes the PROJECT — the session plus every open
      // document — in every view. Gated on the SAME predicate the close guard
      // counts (`projectHasUnsavedWork`: any document dirty, the session
      // dirty, or a never-written project with content), so "the app would
      // warn me about losing this" and "Save does something" stay one
      // condition rather than two that can disagree (O1-2's rule, lifted from
      // the document to the project). M-e: Save also holds the pass lock
      // itself (`runProjectSave` below) — this is the START gate, refusing a
      // save while some OTHER pass already holds it.
      enabled: () => projectHasUnsavedWork() && passFree(),
      reason: passReason,
      run: async () => {
        await runProjectSave(false);
      },
    },
    {
      id: 'file.saveAs',
      label: 'Save As…',
      shortcut: 'Ctrl+Shift+S',
      // An explicit "write this project to a file I am about to name"
      // gesture — meaningful with nothing open and nothing dirty, the same
      // reasoning the document Save As had.
      enabled: () => passFree(),
      reason: passReason,
      run: async () => {
        await runProjectSave(true);
      },
    },
    {
      id: 'file.export',
      label: 'Export…',
      shortcut: 'Ctrl+E',
      // Lot A (M5): in the multitrack view Export renders the session mixdown,
      // so it follows the session (clips exist) rather than the active
      // document. Known, accepted staleness: MenuBar does not subscribe to the
      // session store, so an OPEN File menu re-greys this on the next
      // appStore/history change — the same as `multitrack.mixdown` today.
      // Lot M: this only OPENS the dialog — the pass itself is
      // `ExportDialog.doExport`'s own `runExclusivePass` call, the second seam
      // a modal needs because it publishes no `moduleLock`.
      enabled: (s) =>
        (s.view === 'multitrack' ? hasAnyClip(useSessionStore.getState().session) : hasDoc(s)) &&
        passFree(),
      reason: passReason,
      run: async () => openExportDialog(),
    },
    {
      id: 'file.close',
      label: 'Close',
      shortcut: 'Ctrl+W',
      // M-c / the lot-B close duty (ledger R14): gated on `passLock.ts`'s
      // `closeFree()`, NOT the blanket `passFree()` every other door here
      // uses — see that function's own docblock (fix round 1, item 6: it is
      // exported from there ONCE now, shared with `FilesPanel.tsx`'s row ✕,
      // rather than reimplemented in both places).
      enabled: (s) => hasDoc(s) && closeFree(),
      reason: closeReason,
      run: async () => {
        const id = activeId();
        if (id) await closeDocumentFlow(id);
      },
    },
  ]);
}

// ---- lot A ----
/** File → Save / Save As… (M4): F3 defense-in-depth, moved here from the
 * former `session.save` row. `runCommand` has no try/catch of its own, and
 * `saveProject` already catches its own known failure points, but this keeps
 * ANY escaping error in front of the user instead of vanishing through
 * MenuBar's onClick. A hoisted declaration, so `registerFileCommands` above
 * reaches it the way it reaches `sessionHasClips` below. */
async function runProjectSave(as: boolean): Promise<void> {
  // Lot M (M-e): Save holds the pass lock for the encode's duration — the
  // command's own `enabled` already checked `passFree()`, so a PASS_REFUSED
  // return here means a different pass won a race after that check and
  // before this ran; there is nothing further to do; the command re-greys on
  // the next render either way.
  await runExclusivePass({ id: 'file.save', label: 'Save Project', kind: 'save' }, async () => {
    try {
      await saveProject({ as });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await window.electronAPI?.showMessageBox({ type: 'error', title: 'Save Project failed', message });
    }
  });
}
// ---- end lot A ----

/** Registers the project command that is not a `file.*` row (Task 21, lot A):
 * `session.open` — File → Open Project… — is always available, restores every
 * embedded document into the Files panel and switches the view to
 * 'multitrack' on success. The former `session.save` row is folded into
 * File → Save As… (M4: Save is the project in every view).
 *
 * F3 defense-in-depth: `runCommand` has no try/catch of its own, and before
 * this a thrown/rejected open propagated straight out through MenuBar's
 * onClick with nothing visible to the user. `openSessionViaDialog` already
 * catches its own known failure points, but this wrapper ensures ANY
 * escaping error — known or not — still ends up in front of the user. */
function registerSessionCommands(): void {
  registerCommands([
    {
      id: 'session.open',
      label: 'Open Project…',
      // M-c: has no combo of its own, added for the menu's sake — the same
      // document-lifecycle gate the other three carry.
      enabled: () => passFree(),
      reason: passReason,
      run: async () => {
        try {
          await openSessionViaDialog();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await window.electronAPI?.showMessageBox({ type: 'error', title: 'Open Project failed', message });
        }
      },
    },
  ]);
}

/** Registers one command per registered effect (`effect.<id>`, opens the effect
 * dialog, enabled when a document is active) plus one disabled category-label
 * command per category (`effects.cat.<Category>`). HIDDEN effects (F9) get no
 * command at all: their input cannot come from the generic dialog, so a menu
 * entry for one would only lead to a refusal. Idempotent by id: re-running
 * after new effects register just overwrites/extends. Call after `registerAll`
 * has populated the effect registry (App.tsx does this at startup). */
export function registerEffectCommands(): void {
  const cmds: MenuCommand[] = [];
  for (const effect of getVisibleEffects()) {
    cmds.push({
      id: `effects.cat.${effect.category}`,
      label: effect.category,
      enabled: () => false,
      run: async () => {},
    });
    cmds.push({
      id: `effect.${effect.id}`,
      label: effect.name,
      // D1/D2 — was `activeDoc(s) !== null`, which in multitrack read
      // whatever document happened to be active regardless of any clip
      // selection: exactly the invisible-edit defect v1.36 removed,
      // reintroduced by a different door. `hasPassTarget` restores D1's rule.
      enabled: (s) => hasPassTarget(s) && passFree(),
      reason: pipelineReason,
      run: async () => openEffectDialog(effect.id),
    });
  }
  registerCommands(cmds);
}

// ---- lot E ----
/**
 * Item 4 (N14) — leaving the MULTITRACK view for an editor view with a clip
 * selected shows that clip: its source document becomes active, its source
 * window is selected, the cursor sits at the window's start and the zoom is
 * fitted to the window. Lives here and not in `appStore.setView` because (a)
 * appStore cannot import sessionStore (cycle through undoHistory.ts) and (b)
 * the other multitrack leavers — the panels' "go to" and the producers that
 * `addDocument` then `setView('waveform')` — need the active document left
 * alone. Only the PRIMARY `selectedClipId` counts (a set may span documents;
 * the Properties panel shows the primary too). An orphan clip (source closed)
 * falls through to a plain `setView`.
 */
export function showEditorView(v: 'waveform' | 'spectral'): void {
  const app = useAppStore.getState();
  if (app.view === 'multitrack') {
    const { session, selectedClipId } = useSessionStore.getState();
    const clip =
      selectedClipId === null
        ? null
        : (session.tracks.flatMap((t) => t.clips).find((c) => c.id === selectedClipId) ?? null);
    const doc = clip ? (app.documents.find((d) => d.id === clip.documentId) ?? null) : null;
    if (clip && doc) {
      // Activate FIRST: setActiveDocument applies activationReset (selection
      // null, cursor 0, defaultZoom, playback stopped). Skipped for the doc
      // that is already active — no reset, playback state untouched.
      if (app.activeDocumentId !== doc.id) app.setActiveDocument(doc.id);
      const { start, end } = resolveRegion(
        doc,
        clipSourceWindow(clip, doc.sampleRate, session.sampleRate)
      );
      const s = useAppStore.getState();
      // A window clamped to nothing (clip entirely past its source) selects
      // nothing — a zero-width selection would light Cut/Copy on no audio.
      s.setSelection(end > start ? { start, end } : null);
      s.setCursor(start);
      // Fit the window across the measured lane: resolveZoom clamps spp into
      // [MIN_SPP, fit] and the scroll into [0, length - laneWidth*spp], which
      // for a clamped window is exactly [start, end).
      applyEditorZoom({
        samplesPerPixel: Math.max(1, end - start) / editorLaneWidth(),
        scrollSample: start,
      });
    }
  }
  useAppStore.getState().setView(v);
}
// ---- end lot E ----

/** Registers the Task 19 restoration + view commands: `noise.capture` (top of
 * the Effects menu, enabled only when a selection exists — it profiles the
 * selected region), the real `view.waveform` / `view.spectral` toggles
 * (enabled when an active doc exists and that view isn't already current), and
 * `view.spectralScale` (Task F4 — flips the module-level spectral scale
 * setting; enabled only while the spectral view is active) and `view.beatGrid`
 * (Task B2 — flips the module-level beat-tic visibility; enabled in either
 * editor view). `view.multitrack` stays a disabled stub until Phase D. */
function registerNoiseAndViewCommands(): void {
  registerCommands([
    {
      id: 'noise.capture',
      label: 'Capture Noise Print',
      // D1/D2 — multitrack has no `selection` concept of its own (F1); a
      // resolved clip target stands in for it there, so the OR's multitrack
      // arm needs nothing further once `hasPassTarget` already confirmed one.
      enabled: (s) => hasPassTarget(s) && (s.view === 'multitrack' || s.selection !== null),
      // M-d: NOT gated on the pass lock — synchronous, mouse-only, never in
      // lot M's start-path table — so this reads the PURE target reason, not
      // `pipelineReason` (which would misattribute a disablement that has
      // nothing to do with the lock to "a pass is running").
      reason: passTargetReason,
      run: async () => {
        // R16-adjacent (D1) — pass the resolved clip window straight through
        // in multitrack rather than letting `captureNoiseProfile()` re-derive
        // it from `activeDocumentId`/`selection`, neither of which multitrack
        // maintains for this purpose.
        const s = useAppStore.getState();
        if (s.view === 'multitrack') {
          const target = clipPassTarget();
          if (typeof target === 'string') return; // enabled() already refused this
          captureNoiseProfile({ doc: target.doc, start: target.start, end: target.end });
        } else {
          captureNoiseProfile();
        }
        void window.electronAPI?.showMessageBox({
          type: 'info',
          title: 'Noise Print',
          message:
            'Noise print captured from the selection. Now run Effects → Noise Reduction.',
        });
      },
    },
    {
      id: 'view.waveform',
      label: 'Waveform',
      enabled: (s) => activeDoc(s) !== null && s.view !== 'waveform',
      run: async () => showEditorView('waveform'),
    },
    {
      id: 'view.spectral',
      label: 'Spectral',
      enabled: (s) => activeDoc(s) !== null && s.view !== 'spectral',
      run: async () => showEditorView('spectral'),
    },
    {
      id: 'view.spectralScale',
      label: 'Spectral: Toggle Log/Linear Scale',
      enabled: (s) => s.view === 'spectral',
      run: async () => toggleSpectralScale(),
    },
    {
      // Task B2. A pure display preference: enabled wherever the tics can be
      // drawn, NOT gated on a grid existing. Reading whether one exists would
      // mean a `getBeatGrid` call on every store change just to grey a menu
      // item out, and the user must be able to set the preference before
      // running Detect Tempo, not only after.
      id: 'view.beatGrid',
      label: 'Toggle Beat Grid',
      enabled: (s) => activeDoc(s) !== null && (s.view === 'waveform' || s.view === 'spectral'),
      run: async () => {
        toggleBeatGrid();
      },
    },
    {
      // Task B4. The same rule as `view.beatGrid` — a pure preference, not
      // gated on a grid or a marker existing — but ALWAYS enabled, because
      // snapping governs the multitrack's clip drag/trim as well as the two
      // single-document views, and the multitrack works with no open document.
      id: 'view.snapToGrid',
      label: 'Toggle Snap to Grid',
      enabled: () => true,
      run: async () => {
        toggleSnap();
      },
    },
  ]);
}

/** Registers the whole-document conversion commands (Task 17) in the Edit menu.
 * Both open the ConvertDialog (via the dialog bus) in the matching mode and
 * require an active document. */
function registerDocumentToolCommands(): void {
  registerCommands([
    {
      id: 'edit.convertSampleRate',
      label: 'Convert Sample Rate…',
      enabled: (s) => activeDoc(s) !== null,
      run: async () => openConvertDialog('sampleRate'),
    },
    {
      id: 'edit.convertChannels',
      label: 'Convert Channels…',
      enabled: (s) => activeDoc(s) !== null,
      run: async () => openConvertDialog('channels'),
    },
  ]);
}

/** Inserts the entire active document as a clip at the multitrack cursor. The
 * target track is the one holding the selected clip, else the first track. The
 * placement itself — the doc-rate/session-rate conversion, an empty session
 * adopting the document's rate (MT2), the undo entry and the selection — is
 * `sessionInsert.placeDocumentsOnTrack`, shared with the lane drop and the
 * `insertActiveDocAsClip` test hook. No-op without an active doc or any track. */
function insertActiveDocAsClip(): void {
  const doc = activeDoc(useAppStore.getState());
  if (!doc) return;
  const { session, selectedClipId, mtCursorSample } = useSessionStore.getState();
  if (session.tracks.length === 0) return;

  const owningTrack = selectedClipId
    ? session.tracks.find((t) => t.clips.some((c) => c.id === selectedClipId))
    : undefined;
  const targetTrack = owningTrack ?? session.tracks[0];

  placeDocumentsOnTrack([doc], targetTrack.id, mtCursorSample);
}

/** Renders the session offline to a stereo document, adds it to the Files
 * panel, and switches to the waveform view. Surfaces a message when there is
 * nothing audible to mix (empty / all-muted session). */
async function mixdownToNewFile(): Promise<void> {
  const session = useSessionStore.getState().session;
  const docs = new Map(useAppStore.getState().documents.map((d) => [d.id, d]));
  // Lot M: `mixdownSession` is SYNCHRONOUS — nothing here ever actually
  // awaits — so this hold releases in the same tick it is taken. It is
  // still taken (rather than skipped) so `multitrack.mixdown` enumerates
  // correctly among the app's other pass-start doors and reports its own
  // label while `getRunningPass()` is read anywhere during that tick; it
  // buys no mutual exclusion a synchronous body couldn't already give for
  // free (`multitrack.mixdown`'s own `enabled` already checked `passFree()`).
  const result = await runExclusivePass(
    { id: 'multitrack.mixdown', label: 'Mix Down', kind: 'mixdown' },
    async () => mixdownSession(session, docs)
  );
  if (result === PASS_REFUSED) return;
  const { channels, sampleRate } = result;

  if (channels[0].length === 0) {
    await window.electronAPI?.showMessageBox({
      type: 'info',
      title: 'Mix Down',
      message: 'Nothing audible to mix down.',
    });
    return;
  }

  const n = nextId('mixdown').split('-')[1];
  const doc = createDocument({
    name: `Mixdown ${n}`,
    sampleRate,
    channels: [channels[0], channels[1]],
  });
  useAppStore.getState().addDocument(doc);
  useAppStore.getState().setView('waveform');
}

// ---- lot D ----
/** M2 - "the selected tracks": the owners of `selectedClipIds`. `SessionState`
 * has no track selection, and the clip set is exactly what Delete, Ripple
 * Delete and the group drag already act on, so a split reads the selection the
 * user can already see rather than inventing a second one. */
function selectedTrackIds(): string[] {
  const { session, selectedClipIds } = useSessionStore.getState();
  const member = new Set(selectedClipIds);
  return session.tracks.filter((t) => t.clips.some((c) => member.has(c.id))).map((t) => t.id);
}

/** L1 — `edit.copy`'s multitrack predicate: at least one clip is selected.
 * Reads the session store directly, as `canSplitAtMtCursor` below and
 * `edit.delete` do. */
export function canCopyClips(): boolean {
  return useSessionStore.getState().selectedClipIds.length > 0;
}

/** `edit.split`'s multitrack predicate: some clip on a selected track would be
 * cut at `mtCursorSample` - the EDIT cursor, never `mtPlayheadSample` (N5).
 * Reads the session store directly, exactly as `edit.delete` does, and asks
 * `splitTargets` so the row greys for precisely the cases the store would
 * refuse (an edge, the 32-sample margin, a point in an overlap). */
export function canSplitAtMtCursor(): boolean {
  const { session, mtCursorSample } = useSessionStore.getState();
  return splitTargets(session, selectedTrackIds(), mtCursorSample).length > 0;
}

/** `edit.split`'s multitrack run: the cursor VERBATIM (N1 - it was snapped, or
 * deliberately not, when it was placed; `moveCursorToClipEdge` below records
 * the same ruling), plus the document rates from the app store so a
 * mixed-rate clip's right half reads the right source sample (N3). Returns the
 * right-half ids. */
export function splitSelectedTracksAtMtCursor(): string[] {
  const { mtCursorSample } = useSessionStore.getState();
  const rates = new Map(useAppStore.getState().documents.map((d) => [d.id, d.sampleRate]));
  return splitClipsAt(selectedTrackIds(), mtCursorSample, (id) => rates.get(id));
}

// ---- lot J ----
/** J2 + amendment J2-a — Trim/Silence's OWN scope resolver, deliberately NOT
 * shared with `selectedTrackIds`/`canSplitAtMtCursor` above: J2's ruling text
 * ("the selected clips' tracks, or all tracks when nothing is selected")
 * binds, and `selectedTrackIds()` returns `[]` on empty — which is exactly
 * what makes `edit.split` grey with nothing selected rather than widen. Two
 * rules that differ (`edit.split` greys; Trim/Silence widen) must not share
 * one function, or a future edit to one silently changes the other. */
export function mtRangeScopeTrackIds(): string[] {
  const ids = selectedTrackIds();
  return ids.length > 0 ? ids : useSessionStore.getState().session.tracks.map((t) => t.id);
}

/** `edit.trim`'s multitrack predicate: a range is standing AND `trimTargets`
 * would actually change something on the scoped tracks — the `canSplitAtMtCursor`
 * precedent, so the row greys for exactly what the store would refuse (J9:
 * a whole-timeline range emits no target and greys here, rather than running
 * as a silent no-op). */
export function canTrimMtRange(): boolean {
  const { session, mtTimeRange } = useSessionStore.getState();
  return mtTimeRange !== null && trimTargets(session, mtRangeScopeTrackIds(), mtTimeRange).length > 0;
}

/** `edit.trim`'s multitrack run: J1 (keeps the range where it is) via the
 * store's own `trimClipsToRange`, over the swept range and the scope above. */
export function trimMtRange(): void {
  const { mtTimeRange } = useSessionStore.getState();
  if (mtTimeRange === null) return;
  trimClipsToRange(mtRangeScopeTrackIds(), mtTimeRange);
}

/** `edit.silence`'s multitrack predicate — the `canTrimMtRange` shape over
 * `silenceTargets` (J4). */
export function canSilenceMtRange(): boolean {
  const { session, mtTimeRange } = useSessionStore.getState();
  return mtTimeRange !== null && silenceTargets(session, mtRangeScopeTrackIds(), mtTimeRange).length > 0;
}

/** `edit.silence`'s multitrack run: J4 (clears the range on the scoped
 * tracks, leaves the hole) via `silenceClipsInRange`, passing document rates
 * the way `splitSelectedTracksAtMtCursor` does above (N3) for the split arm
 * a spanning clip may need. */
export function silenceMtRange(): void {
  const { mtTimeRange } = useSessionStore.getState();
  if (mtTimeRange === null) return;
  const rates = new Map(useAppStore.getState().documents.map((d) => [d.id, d.sampleRate]));
  silenceClipsInRange(mtRangeScopeTrackIds(), mtTimeRange, (id) => rates.get(id));
}
// ---- end lot J ----
// ---- end lot D ----

// ---- merge clips ----
/** `multitrack.joinClips`' predicate (D1): the clip selection holds TWO OR
 * MORE clips on at least one track. Asks `mergeTargets` — the same question the
 * verb itself answers — so the row greys for precisely the selections the merge
 * would refuse, and reads the session store directly, exactly as
 * `canSplitAtMtCursor` above does. */
export function canMergeSelectedClips(): boolean {
  const { session, selectedClipIds } = useSessionStore.getState();
  return mergeTargets(session, selectedClipIds).length > 0;
}

/**
 * D2/D7 — the merge: one baked document per merged track, then ONE session
 * gesture. Returns the merged clip ids (`[]` when nothing qualifies).
 *
 * The document half is `mixdownToNewFile`'s pattern verbatim — `createDocument`
 * + `addDocument`, so the audio is minted OUTSIDE the undo gesture (a document
 * is never an undo entry here) and the last one added becomes active, which is
 * what every computed document in this app does (D7). The bake is handed the
 * SESSION rate, not the members' document rate: the merged clip lives on the
 * timeline, and `readClipSlice` is what reconciles a mixed-rate member.
 *
 * `commitMergedClips` owns the session write and the selection afterwards; this
 * function never touches the session store's clip actions itself.
 */
export function mergeSelectedClips(): string[] {
  const { session, selectedClipIds } = useSessionStore.getState();
  const targets = mergeTargets(session, selectedClipIds);
  if (targets.length === 0) return [];

  const docs = new Map(useAppStore.getState().documents.map((d) => [d.id, d]));
  const entries = targets.map((target) => {
    // `mergeTargets` derived every `trackId` from this same session, so the
    // lookup cannot miss.
    const track = session.tracks.find((t) => t.id === target.trackId)!;
    const { channels, sampleRate } = bakeMergedClip(track, target, docs, session.sampleRate);
    // D2 — `Join N`, numbered off its own counter like `Mixdown N`. No
    // `filePath`, so `createDocument` stamps `neverSaved` itself (S4's default);
    // passing the flag would restate a rule that already holds.
    // H1 (lot H): renamed with the command's label — a `Merge 1` file under a
    // button labelled Join would be the stale-label defect this repo tracks.
    // Old `.audm` projects keep the name they stored; document names are data,
    // not derived.
    const n = nextId('join').split('-')[1];
    const doc = createDocument({ name: `Join ${n}`, sampleRate, channels });
    useAppStore.getState().addDocument(doc);
    return { target, documentId: doc.id };
  });

  return commitMergedClips(entries);
}
// ---- end merge clips ----

/** Registers the Task 22 multitrack commands: the real `view.multitrack`
 * toggle (always available — the multitrack view works with no open document),
 * `multitrack.addTrack`, `multitrack.insertDoc`, `multitrack.mixdown` and
 * `multitrack.joinClips`. The action commands are enabled only while the
 * multitrack view is active. */
function registerMultitrackCommands(): void {
  registerCommands([
    {
      id: 'view.multitrack',
      label: 'Multitrack',
      enabled: (s) => s.view !== 'multitrack',
      run: async () => useAppStore.getState().setView('multitrack'),
    },
    {
      id: 'multitrack.addTrack',
      label: 'Add Track',
      enabled: (s) => s.view === 'multitrack',
      run: async () => useSessionStore.getState().addTrack(),
    },
    {
      id: 'multitrack.insertDoc',
      label: 'Insert Active File at Cursor',
      enabled: (s) => s.view === 'multitrack' && activeDoc(s) !== null,
      run: async () => insertActiveDocAsClip(),
    },
    {
      id: 'multitrack.mixdown',
      label: 'Mix Down to New File',
      enabled: (s) =>
        s.view === 'multitrack' && hasAnyClip(useSessionStore.getState().session) && passFree(),
      reason: passReason,
      run: async () => mixdownToNewFile(),
    },
    {
      // D6 — Split's inverse, and the second command here that mints a
      // document. The predicate is the verb's own question (D1), so the row
      // greys for exactly the selections `mergeSelectedClips` would refuse.
      // H1/H5 (lot H): renamed "Join Clips", id renamed to match (`joinClips`)
      // — everywhere the user can see it — and it now advertises the bare `J`
      // SHORTCUT_TABLE binds it to (H2: `M` stays Add Marker, so Join could
      // not take it). `mergeSelectedClips`/`canMergeSelectedClips` and the
      // `mergeClips.ts` module keep their names (not user-visible; renaming a
      // module here would be pure churn).
      id: 'multitrack.joinClips',
      label: 'Join Clips',
      shortcut: 'J',
      enabled: (s) => s.view === 'multitrack' && canMergeSelectedClips(),
      run: async () => {
        mergeSelectedClips();
      },
    },
    // K1 R1 — the two halves of clip-edge navigation. Both are the same
    // two-line adapter over `clipEdges`: read the session's boundaries, ask
    // which one lies in that direction, write the cursor if there is one.
    //
    // `setMtCursor` is the whole write. The multitrack cursor is where the NEXT
    // play starts (`transportService` reads it once, at `play()`), so moving it
    // during playback moves the next start and nothing else — the running
    // transport is driven by `mtPlayheadSample`, which these never touch. That
    // is what makes them safe while playing, and it is a property of the
    // existing cursor contract rather than anything K1 added.
    //
    // Enabled on `hasAnyClip` — no clips, no edges, so the key would have
    // nowhere to go and the menu row should say so.
    {
      id: 'multitrack.prevClipEdge',
      label: 'Previous Clip Edge',
      shortcut: 'Ctrl+Left',
      enabled: (s) => s.view === 'multitrack' && hasAnyClip(useSessionStore.getState().session),
      run: async () => moveCursorToClipEdge('prev'),
    },
    {
      id: 'multitrack.nextClipEdge',
      label: 'Next Clip Edge',
      shortcut: 'Ctrl+Right',
      enabled: (s) => s.view === 'multitrack' && hasAnyClip(useSessionStore.getState().session),
      run: async () => moveCursorToClipEdge('next'),
    },
  ]);
}

/** K1 R1 — moves the multitrack cursor to the previous/next clip boundary, or
 * leaves it exactly where it is when there is none in that direction. */
function moveCursorToClipEdge(direction: 'prev' | 'next'): void {
  const { session, mtCursorSample, setMtCursor } = useSessionStore.getState();
  const target = nextClipEdge(clipBoundaries(session), mtCursorSample, direction);
  if (target === null) return;
  setMtCursor(target);
}

/** Returns the active document's markers (sorted by position, per the store's
 * invariant), or `[]` when there is no active document. */
function activeDocMarkers(s: AppState): Marker[] {
  return s.activeDocumentId ? (s.markers[s.activeDocumentId] ?? []) : [];
}

/** Registers the real marker commands (Task 23), overwriting the disabled
 * `marker.add`/`marker.next`/`marker.prev` stubs. `marker.add` inserts a
 * sequentially-named marker (`Marker <n>`, n taken from the generated id's
 * suffix) at the cursor — the store keeps the array sorted by position.
 * `marker.next`/`marker.prev` jump the cursor to the nearest marker strictly
 * after/before it, with NO wraparound; both report enabled whenever the
 * active document has ANY marker at all (a cheap existence check, not a
 * directional one — see task resolution), and run() is a safe no-op when
 * there is nothing in that direction. */
function registerMarkerCommands(): void {
  registerCommands([
    {
      id: 'marker.add',
      label: 'Add Marker',
      shortcut: 'M',
      // N10: editor views only — Multitrack shows no document for M to mark.
      enabled: (s) => s.view !== 'multitrack' && activeDoc(s) !== null,
      run: async () => {
        const { activeDocumentId, cursorSample, markers, addMarker } = useAppStore.getState();
        if (!activeDocumentId) return;
        const before = markers[activeDocumentId] ?? [];
        const id = nextId('marker');
        const n = id.split('-')[1];
        addMarker(activeDocumentId, { id, name: `Marker ${n}`, positionSample: cursorSample });
        const after = useAppStore.getState().markers[activeDocumentId] ?? [];
        pushMarkerUndo('Add Marker', activeDocumentId, before, after);
      },
    },
    {
      id: 'marker.next',
      label: 'Next Marker',
      enabled: (s) => activeDocMarkers(s).length > 0,
      run: async () => {
        const state = useAppStore.getState();
        const next = activeDocMarkers(state).find((m) => m.positionSample > state.cursorSample);
        if (next) state.setCursor(next.positionSample);
      },
    },
    {
      id: 'marker.prev',
      label: 'Previous Marker',
      enabled: (s) => activeDocMarkers(s).length > 0,
      run: async () => {
        const state = useAppStore.getState();
        let prev: Marker | undefined;
        for (const m of activeDocMarkers(state)) {
          if (m.positionSample < state.cursorSample) prev = m;
          else break;
        }
        if (prev) state.setCursor(prev.positionSample);
      },
    },
  ]);
}

/** Registers the Task T5/T8 tempo commands: `tempo.detect` and `tempo.match`
 * open the Pipeline menu's Tempo & Timing group (F11-7). They used to head the
 * Effects menu beside `noise.capture`, which Plan Ruling 5 required by
 * forbidding a sixth `MenuSection['title']`; the user overruled that ruling.
 * `tempo.detect` fires `runTempoAnalysis`, which itself never throws/rejects
 * and surfaces its own failure dialog — no try/catch needed here, matching
 * `effect.<id>`'s run() above. `tempo.match` just opens the dialog through
 * the bus (Task T8), matching `edit.convertSampleRate`/`edit.convertChannels`
 * above. */
function registerTempoCommands(): void {
  registerCommands([
    {
      id: 'tempo.detect',
      label: 'Detect Tempo',
      enabled: (s) => hasPassTarget(s) && passFree(),
      reason: pipelineReason,
      run: async () => {
        // D1 — `tempo.detect` opens no hosted card (no `beginClipWork` seam
        // to mint a working document for it), and it WRITES nothing to the
        // document itself (it caches a per-document tempo analysis entry
        // keyed by doc id): it needs the right document and no working copy.
        // Multitrack reads the selected clip's own SOURCE document, not a
        // copy — analysing the source is exactly what should be cached.
        const d = multitrackToolDoc(useAppStore.getState());
        if (!d) return;
        // Lot M: `tempo.detect` runs with no hosted card behind it (no
        // dialog, no `moduleLock`), so it is one of the three bodies that
        // must take the lock itself rather than relying on a card's own
        // `handleToolModuleLock` publish.
        await runExclusivePass(
          { id: 'tempo.detect', label: 'Detect Tempo', kind: 'pipeline' },
          async () => runTempoAnalysis(d)
        );
      },
    },
    {
      id: 'tempo.match',
      label: 'Match Tempo',
      // D1 — `tempo.match` IS a `CLIP_WORK_COMMANDS` member: `App.tsx`'s
      // `openTool` mints and activates a working copy before `TempoDialog`
      // ever renders, so the dialog's own `activeDoc` read (unchanged, per
      // this lot's process) already resolves to the right document. Nothing
      // to prime here.
      enabled: (s) => hasPassTarget(s) && passFree(),
      reason: pipelineReason,
      run: async () => openTempoDialog(),
    },
    {
      // F9. Sits beside Match Tempo because it answers the same user question
      // ("this is not in time") with the one thing Match Tempo structurally
      // cannot do -- a per-syllable rate instead of one ratio for the whole
      // region. It is a command rather than an `effect.<id>` entry because its
      // input is a confirmed anchor list, not scalar params (see
      // `EffectDefinition.hidden`).
      id: 'timing.align',
      label: 'Align Vocal Timing',
      // D1 — `CLIP_WORK_COMMANDS` member, same reasoning as `tempo.match`.
      enabled: (s) => hasPassTarget(s) && passFree(),
      reason: pipelineReason,
      run: async () => openAlignTimingDialog(),
    },
  ]);
}

/** Registers the Task T14 Auto-Remix command. F11-7: it closes the PIPELINE
 * menu's Tempo & Timing group, beside the two tempo tools whose analysis it
 * shares. T14's original argument — not in Effects, which is built live from
 * `getAllEffects()` and only holds `EffectDefinition`s (a remix is a
 * multi-second analysis producing a NEW document, which
 * `EffectDefinition.process` — pure, synchronous, returning channels for the
 * SAME document — structurally cannot express) — still rules out Effects; it
 * only ever put the command in Edit for want of anywhere better. `enabled`
 * stays O(1) and pure: MenuBar re-evaluates every item on every store change.
 * No shortcut. */
function registerRemixCommands(): void {
  registerCommands([
    {
      id: 'edit.remix',
      label: 'Auto-Remix',
      // R16 — a document-PRODUCING row: D2-a excludes it from `hasPassTarget`
      // (it mints a NEW document; D1's clip WINDOW is not a target it can
      // express), but it still needs the RIGHT document, not whatever is
      // merely active — `multitrackToolDoc` prefers the selected clip's
      // source in multitrack.
      enabled: (s) => {
        const d = multitrackToolDoc(s);
        return d !== null && docLength(d) > 0 && passFree();
      },
      reason: passReason,
      run: async () => {
        primeMultitrackDocTarget();
        openRemixDialog();
      },
    },
  ]);
}

/** Registers the Task S6 stem-separation command. F11-7: it closes the PIPELINE
 * menu's Analysis group, beside Transcribe — the other whole-file model run.
 * S6's plan ruling 8 had put it beside Auto-Remix instead, on the shared
 * property that both produce NEW documents (which the Effects menu's
 * `EffectDefinition.process` — pure, synchronous, returning channels for the
 * SAME document — structurally cannot express). That property still rules out
 * Effects; the Pipeline groups by subject, so the two are no longer neighbours.
 * Identical `enabled` rule (an active document with audio in it), and no
 * shortcut: this is a multi-minute job that should never be one keystroke
 * away. */
function registerStemCommands(): void {
  registerCommands([
    {
      id: 'edit.separateStems',
      label: 'Separate into Stems',
      // R16 — see `edit.remix`'s identical comment.
      enabled: (s) => {
        const d = multitrackToolDoc(s);
        return d !== null && docLength(d) > 0 && passFree();
      },
      reason: passReason,
      run: async () => {
        primeMultitrackDocTarget();
        openSeparateDialog('stems');
      },
    },
    // D4 — Separate Voice. The SAME separation run as the row above, landed as
    // two tracks (Voice + Backing) instead of five, so it is registered here
    // beside it rather than in a module of its own: one service, one dialog,
    // one model download, two landings. Hence also the identical predicate —
    // it is gated by what the RUN needs, not by which menu group it sits in —
    // and no shortcut, for the same reason (minutes of inference). D7 puts it
    // in the Pipeline menu's Voice group, at its head.
    {
      id: 'voice.separate',
      label: 'Separate Voice',
      // R16 — see `edit.remix`'s identical comment.
      enabled: (s) => {
        const d = multitrackToolDoc(s);
        return d !== null && docLength(d) > 0 && passFree();
      },
      reason: passReason,
      run: async () => {
        primeMultitrackDocTarget();
        openSeparateDialog('voice');
      },
    },
  ]);
}

/** F4b — Transcribe. F11-8: it is now the door to BOTH halves of the feature.
 * The user ruled that "Spatial and Transcript are single tools, they should not
 * be a module", so the module strip stopped carrying a Transcript icon and this
 * command absorbed what that icon did: with a transcript already in the store
 * for the active document it SHOWS that transcript, and only with none does it
 * open the run dialog.
 *
 * Which way round matters. Re-running is minutes of inference that would
 * produce the thing already sitting in the store, so making that the default
 * would charge the user for a look; whereas showing a transcript costs nothing
 * and the run is still one click away, on the panel's own 'Transcribe again…'
 * button (F11-8 added it — the stale banner has been telling users to
 * transcribe again since F4b with no control to do it with). The branch is on
 * EXISTENCE, not on staleness: a stale transcript is still the one the user
 * made, the panel says so in amber at the top, and that is a better answer to
 * "show me the transcript" than silently starting a second run.
 *
 * The `enabled` predicate is unchanged and deliberately still document-and-
 * audio gated: the reveal arm is the exception this command makes, not a new
 * always-available surface.
 *
 * F11-7: it OPENS the Pipeline menu's Analysis group, with
 * Separate into Stems after it. Both are long analyses over the whole document
 * that the Effects menu's pure, synchronous `EffectDefinition.process`
 * structurally cannot express — the reason neither is an `effect.<id>` — and
 * both read the file rather than reshaping a take, which is why they share a
 * group rather than sitting in Voice. Identical `enabled` rule (an active
 * document with audio in it), and no shortcut — a multi-minute job should never
 * be one keystroke away. */
function registerTranscribeCommands(): void {
  registerCommands([
    {
      id: 'edit.transcribe',
      label: 'Transcribe',
      // R16 — see `edit.remix`'s identical comment.
      enabled: (s) => {
        const d = multitrackToolDoc(s);
        return d !== null && docLength(d) > 0 && passFree();
      },
      reason: passReason,
      run: async () => {
        // R16 — primed BEFORE the existing-transcript check below, so in
        // multitrack that check asks about the SELECTED CLIP's document too:
        // unprimed, this reveal arm would read whatever was merely active,
        // showing (or failing to show) the wrong document's transcript.
        primeMultitrackDocTarget();
        const id = useAppStore.getState().activeDocumentId;
        if (id !== null && getTranscript(id) !== null) {
          focusTranscriptPanel();
          return;
        }
        openTranscribeDialog();
      },
    },
  ]);
}

/** F3 — Voice Changer. F11-7 put it at the head of the Pipeline menu's Voice
 * group, ahead of the two chains — it is the one tool there that replaces the
 * voice rather than cleaning it, so everything after it operates on whatever it
 * produced. D4/D7 moved it one row down: `voice.separate` opens the group now,
 * because isolating the voice comes before replacing it. The rest of that
 * argument stands, and this is still the first row that RESHAPES a take.
 * It is not an `effect.<id>` for the structural reason F3 gave: a long
 * CPU-inference job producing a NEW document, which the Effects menu's pure,
 * synchronous `EffectDefinition.process` (same-document channels in, channels
 * out) cannot express. Identical `enabled` rule, and no shortcut — a
 * minutes-long job should never be one keystroke away. */
function registerVoiceCommands(): void {
  registerCommands([
    {
      id: 'edit.voiceChanger',
      label: 'Voice Changer',
      // R16 — see `edit.remix`'s identical comment.
      enabled: (s) => {
        const d = multitrackToolDoc(s);
        return d !== null && docLength(d) > 0 && passFree();
      },
      reason: passReason,
      run: async () => {
        primeMultitrackDocTarget();
        openVoiceChangerDialog();
      },
    },
  ]);
}

/** F7 — the Vocal Chain. F11-7: it sits in the PIPELINE menu's Voice group,
 * after Voice Changer and before Cover Chain. F7 had placed it in the Effects
 * menu after 'Align Vocal Timing…' because it is a same-document, in-place
 * transform of the selection (unlike Auto-Remix / Separate / Transcribe, which
 * produce NEW documents and so lived in Edit) — that distinction no longer
 * decides anything now that all of them are in one menu grouped by subject.
 * It is a command rather than an
 * `effect.<id>` entry because it is not one `EffectDefinition`: it composes
 * several of them, deriving each one's settings from the audio that reaches it,
 * which scalar params in an EffectDialog cannot express. Same `enabled` rule as
 * `timing.align` — an active document — and no shortcut: this is a multi-stage
 * pass that should never be one keystroke away. */
function registerVocalChainCommands(): void {
  registerCommands([
    {
      id: 'effects.vocalChain',
      label: 'Vocal Chain',
      // D1 — `CLIP_WORK_COMMANDS` member, same reasoning as `tempo.match`.
      enabled: (s) => hasPassTarget(s) && passFree(),
      reason: pipelineReason,
      run: async () => openVocalChainDialog(),
    },
  ]);
}

/** F10 — the Cover Chain. F11-7: it sits in the PIPELINE menu's Voice group,
 * still immediately AFTER 'Vocal Chain' — the one run-order adjacency the
 * regrouping preserved, and the cover chain's own `clean` stage note is why it
 * has to be: the match is a correction to a CLEAN take, so the vocal chain runs
 * first. Like the vocal chain it is a command
 * rather than an `effect.<id>` entry, because it is not one `EffectDefinition`:
 * it composes four of them and derives each one's settings from a SECOND
 * document — the separated original vocal — which scalar params in an
 * EffectDialog cannot express. Same `enabled` rule, and no shortcut: a pass this
 * long should never be one keystroke away. */
function registerCoverChainCommands(): void {
  registerCommands([
    {
      id: 'effects.coverChain',
      label: 'Cover Chain',
      // D1 — a THIRD case, disabled in multitrack OUTRIGHT rather than
      // gated on a clip target: `runCoverJourney` replaces the WHOLE
      // session (`coverJourney.ts`'s `useSessionStore.setState({session,…})`
      // + `clearSessionHistory()` + `setView('multitrack')`), so there is no
      // clip-scoped shape for it to express at all — D1 applied, not a
      // deviation (F1's shape: a command that cannot express the target is
      // refused). `passFree()` is KEPT here (a deliberate correction to the
      // brief's literal `s.view !== 'multitrack' && activeDoc(s) !== null`,
      // which drops it): dropping the pass-lock gate would let Cover Chain
      // start while another pass runs, an M1 regression X1 forbids.
      enabled: (s) => s.view !== 'multitrack' && activeDoc(s) !== null && passFree(),
      reason: (s) => passReason() ?? (s.view === 'multitrack' ? COVER_CHAIN_MULTITRACK_REASON : undefined),
      run: async () => openCoverChainDialog(),
    },
  ]);
}

/** D6 — the Podcast Chain. It sits in the Pipeline menu's Voice group
 * immediately after 'Cover Chain', which is D7's placement and also the only
 * order this group could put it in: the three multi-stage passes run together,
 * and this one is the spoken-word member of the set. Like both chains before it
 * it is a command rather than an `effect.<id>` entry, because it is not one
 * `EffectDefinition`: it composes nine of them, derives each one's settings from
 * the audio that reaches it, and adds a stage that is no effect at all — the
 * BS.1770-4 loudness measurement and the one gain that lands the delivery
 * target. Same `enabled` rule as the other two, and no shortcut: a ten-stage
 * pass should never be one keystroke away. */
function registerPodcastChainCommands(): void {
  registerCommands([
    {
      id: 'effects.podcastChain',
      label: 'Podcast Chain',
      // D1 — `CLIP_WORK_COMMANDS` member, same reasoning as `tempo.match`.
      enabled: (s) => hasPassTarget(s) && passFree(),
      reason: pipelineReason,
      run: async () => openPodcastChainDialog(),
    },
  ]);
}

/** F6 — Align Lyrics. F11-7: it CLOSES the Pipeline menu's Voice group. F6 had
 * placed it in the Effects menu between 'Align Vocal Timing…' and 'Vocal
 * Chain…' because that is the order the three are RUN in — both manual steps
 * before the chain, and a word replaced before any length-changing stage moves
 * the spans it was measured against. The Pipeline groups by subject instead, so
 * the menu no longer says that anywhere; `vocalChain.ts`'s `lyrics` stage note
 * is now the only place it is stated, and that note names this menu path.
 * It is a command rather
 * than an `effect.<id>` entry for the same structural reason as the chain: it
 * is not one pure `EffectDefinition.process`, it is a model run plus a
 * per-word splice the user drives. Its `enabled` rule is `timing.align`'s PLUS
 * one condition: an active document AND `docLength > 0`. `timing.align` asks
 * only for the document — it opens a dialog that reports its own refusals —
 * whereas this one hands the region to a model, and an empty document has
 * nothing to align. No shortcut either: a 378 MB download and a multi-second
 * inference should never be one keystroke away. */
function registerAlignLyricsCommands(): void {
  registerCommands([
    {
      id: 'lyrics.align',
      label: 'Align Lyrics',
      // D1 — `CLIP_WORK_COMMANDS` member, same reasoning as `tempo.match`.
      // The non-multitrack arm keeps its own `docLength(d) > 0` clause —
      // `timing.align`'s `hasPassTarget` alone asks only for a document;
      // this one hands the region to a model, and an empty document has
      // nothing to align. The multitrack arm needs no separate check:
      // `clipPassTarget()`'s `empty-window` refusal already covers it
      // (D2/D4's "this clip reads nothing from its source file").
      enabled: (s) => {
        if (s.view !== 'multitrack') {
          const d = activeDoc(s);
          return d !== null && docLength(d) > 0 && passFree();
        }
        return hasPassTarget(s) && passFree();
      },
      reason: pipelineReason,
      run: async () => openAlignLyricsDialog(),
    },
  ]);
}

/** F11-8 — the Spatial positioner. It closed the Pipeline menu as its own
 * 'Mix' group until T8, when the user moved it to the EFFECTS menu ("move the
 * Spacial tool to the effects module") — it closes that menu as its own Mix
 * group now, and the Effects card draws the matching Mix row.
 * The user ruled that "Spatial and Transcript are single tools, they
 * should not be a module", so the module strip no longer carries an icon for
 * the positioner and this command is the ONLY door it has: it opens no dialog
 * — it puts the existing panel, untouched, into the module card through the
 * bus, exactly as `focusRemixPanel`/`focusTranscriptPanel` do. (This label
 * originally had no ellipsis BECAUSE it opens no dialog, the convention
 * `tempo.detect` followed too. T8 superseded that convention: the user had the
 * dots removed from every Pipeline label, so a plain label no longer says
 * anything about dialogs — in this menu the dots-mean-a-dialog rule is dead.)
 *
 * ALWAYS enabled, and it is the only row in its menu that is (every Pipeline
 * row and every effect row acts on the active document; the noise print needs
 * a selection). The positioner writes automation onto a multitrack
 * TRACK, which exists with no document open at all — the multitrack view works
 * in an empty app. Gating it on `activeDoc(s) !== null` would grey it in the
 * one state the multitrack user is most likely to be in, and gating it on the
 * session having tracks would replace a panel that says "No tracks in the
 * session." with a grey row that says nothing. The strip icon it replaces was
 * clickable in every state; this keeps that true. */
function registerSpatialCommands(): void {
  registerCommands([
    {
      id: 'spatial.position',
      label: 'Spatial Positioner',
      enabled: () => true,
      run: async () => focusSpatialPanel(),
    },
  ]);
}

registerDefaultCommands();
registerSelectionAndTransportCommands();
registerEditCommands();
registerFileCommands();
registerSessionCommands();
registerDocumentToolCommands();
registerNoiseAndViewCommands();
registerMultitrackCommands();
registerMarkerCommands();
registerTempoCommands();
registerRemixCommands();
registerStemCommands();
registerTranscribeCommands();
registerVoiceCommands();
registerVocalChainCommands();
registerCoverChainCommands();
registerPodcastChainCommands();
registerAlignLyricsCommands();
registerSpatialCommands();
