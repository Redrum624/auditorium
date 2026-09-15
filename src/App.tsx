import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { X } from 'lucide-react';
import WaveformView from './components/Editor/WaveformView';
import SpectrogramView from './components/Editor/SpectrogramView';
import MultitrackView from './components/Multitrack/MultitrackView';
import ConvertDialog from './components/Dialogs/ConvertDialog';
// ---- lot B ----
// Item 6: an effect is hosted in the module column, not mounted as a modal.
import EffectHost from './components/Dialogs/EffectHost';
// ---- /lot B ----
import ExportDialog from './components/Dialogs/ExportDialog';
import NewFileDialog from './components/Dialogs/NewFileDialog';
import RecordDialog from './components/Dialogs/RecordDialog';
// U2: the nine pipeline tools are no longer mounted here as modals — they are
// mounted by the host card, in the module column, unchanged. See
// components/Dialogs/PipelineToolHost.tsx for the registry and the width.
import PipelineToolHost, { TOOL_HOST_WIDTH } from './components/Dialogs/PipelineToolHost';
import EffectsPanel from './components/Panels/EffectsPanel';
import FilesPanel from './components/Panels/FilesPanel';
import HistoryPanel from './components/Panels/HistoryPanel';
import MarkersPanel from './components/Panels/MarkersPanel';
// U2: the Pipeline module's card — the Pipeline menu's tools, same registry.
import PipelinePanel from './components/Panels/PipelinePanel';
import PropertiesPanel from './components/Panels/PropertiesPanel';
import RemixPanel from './components/Panels/RemixPanel';
import SpatialPanel from './components/Panels/SpatialPanel';
import TranscriptPanel from './components/Panels/TranscriptPanel';
import EditToolbar from './components/Layout/EditToolbar';
import ModuleStrip, {
  // U2: the app-start card, derived from the strip registry's lead entry.
  DEFAULT_PANEL,
  MODULE_COLUMN_WIDTH,
  MODULE_PANELS,
  type PanelId,
} from './components/Layout/ModuleStrip';
import StatusBar from './components/Layout/StatusBar';
import TempoCard from './components/Layout/TempoCard';
import TitleBar from './components/Layout/TitleBar';
import Toolbar from './components/Layout/Toolbar';
import { GlassCard, IconTile } from './components/UI/glass';
// ---- lot B ----
// Item 6: the hosted effect's own name, for the refusal message.
import { getEffect } from './effects/EffectRegistry';
// ---- /lot B ----
import { registerAllEffects } from './effects/registerAll';
import { registerDialogSetters, type ConvertMode } from './services/dialogBus';
// ---- lot M ----
// Item 13 / M1/M4/M5: the app-wide single-pass lock, and the two seams (lot
// C fix round 1: one per retained slot) that acquire/release it for every
// HOSTED dialog — see `handleToolLock`/`handleEffectLock` below.
import {
  acquirePass,
  blockedByPassReason,
  passBusyReason,
  usePassLock,
  type PassDescriptor,
} from './services/passLock';
// ---- /lot M ----
import { getInFlightSaveCount, projectDirtyCount } from './services/fileService';
import { isProjectSaveInFlight } from './multitrack/sessionFile';
import { getRemixSession, useRemixVersion } from './services/remixService';
import { getStemBusyCount } from './services/stemService';
import { getTranscribeBusyCount } from './services/transcribeService';
import { getDiarizeBusyCount } from './services/diarizeService';
import { getVoiceBusyCount } from './services/voiceService';
import { getAlignBusyCount } from './services/alignLyricsService';
import { registerEffectCommands } from './services/menuActions';
// U2-3: the running tool's own label, for the refusal message.
import { getPipelineGroups } from './services/pipelineTools';
import { installShortcuts } from './services/shortcuts';
import { installTestHooks } from './services/testHooks';
// ---- lot D ----
// Item 4 (D1/R16) — the clip-scoped working-copy lifecycle. `openTool`/
// `openEffect` open a slot (only when the command actually qualifies —
// `beginClipWork` is itself the no-op gate); `closeTool`/`closeEffect` and the
// App-unmount safety net below release it. See `clipPass.ts`'s own docblock.
import { beginClipWork, endClipWork, EFFECT_CARD_WORK_ID } from './services/clipPass';
// ---- /lot D ----
import { multitrackRecorder } from './multitrack/multitrackRecord';
import { stopAll } from './services/transportService';
import { useAppStore } from './stores/appStore';

// G4: the two flat sidebars (left Files/Effects column + right tab strip)
// became ONE icon rail driving a single glass panel card, with
// Files and Effects as additive entries now that the always-visible left
// column is retired (user-approved via the 2026-07-28 mockup). 'remix' is
// also reachable through `focusRemixPanel()` (dialogBus) the moment a remix
// document is created, without the user finding the rail entry first.
//
// F11-8: that "also" is the whole rule now for three of the panels. The strip
// draws five permanent icons; Remix appears only while a remix document exists,
// and Spatial and Transcript have no icon at all — they are single tools, so
// their commands (`spatial.position`, `edit.transcribe`) put their panels in
// this same card through the bus. The card renders from MODULE_PANELS, which is
// the wider list.
//
// U1: the rail rotated horizontal and moved into components/Layout/
// ModuleStrip.tsx (layout E2) — same ids, same order, same `sidebar-tabs`
// testid and accessible names; see that file for the anatomy and for why the
// active entry now toggles its card closed.

// The module column's right/top/bottom margins. Left as constants because two
// separate surfaces have to agree on them: the column itself, and the stage
// inset the editor views lay out against.
const COLUMN_MARGIN = 14;
/** Stage clearance while a panel card is open: the column's footprint plus one
 * margin of air between the card and the waveform. */
const STAGE_INSET_RIGHT_OPEN = COLUMN_MARGIN + MODULE_COLUMN_WIDTH + COLUMN_MARGIN;
/** U2-3: the same clearance for the wider tool-host card. The host grows
 * leftward out of the 348px column (see TOOL_HOST_WIDTH), so the stage has to
 * step back by the difference or the waveform would run under it. */
const STAGE_INSET_RIGHT_HOSTED = COLUMN_MARGIN + TOOL_HOST_WIDTH + COLUMN_MARGIN;

// Populate the effect registry and its menu commands once at module load — before
// the first render — so the Effects menu and panel are fully built on first paint.
registerAllEffects();
registerEffectCommands();

export default function App() {
  const documents = useAppStore((s) => s.documents);
  const activeDocumentId = useAppStore((s) => s.activeDocumentId);
  const view = useAppStore((s) => s.view);
  const doc = documents.find((d) => d.id === activeDocumentId) ?? null;

  const [exportOpen, setExportOpen] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  // ---- lot B ----
  // Item 6 / M6: the effect the module column hosts, or null. Its own
  // retained slot (lot C fix round 1, C5) — RETAINED independently of
  // `hostedTool` now; `columnHost` below is what decides which of the two,
  // if either, is the VISIBLE one. Used to be `effectDialogId`, a modal flag.
  const [hostedEffect, setHostedEffect] = useState<string | null>(null);
  // ---- /lot B ----
  const [convertMode, setConvertMode] = useState<ConvertMode | null>(null);
  const [recordOpen, setRecordOpen] = useState(false);
  // U2-3: the nine `useState` flags that used to mount nine modals became ONE
  // command id — the pipeline tool the module column is hosting, or null.
  // Lot C fix round 1 (C5): its OWN retained slot, independent of
  // `hostedEffect` — the pass lock (`passLock.ts`, lot M) is now two
  // acquire/release pairs, `hostPassRef.tool` and `hostPassRef.effect` below,
  // one per slot, never a shared single ref or a counter.
  const [hostedTool, setHostedTool] = useState<string | null>(null);
  // ---- lot C ----
  // Item 3 (C1/C2/C5, fix round 1) — TWO retained slots, `hostedTool` and
  // `hostedEffect`, and which of them (if either) is the FOREGROUNDED
  // (visible) surface. Opening one no longer nulls the other (C5: "at most
  // one effect card AND one hosted tool are retained at a time" — two
  // slots); a module switch never unmounts either — it only moves this flag.
  const [columnHost, setColumnHost] = useState<'tool' | 'effect' | null>(null);
  const columnHostRef = useRef<'tool' | 'effect' | null>(null);
  columnHostRef.current = columnHost;
  // ---- /lot C ----
  // U1: null = no panel card open. The strip's active entry closes it, which
  // is what lets the stage take the column's width (E2's "the waveform takes
  // every liberated pixel").
  //
  // F11-8: the card is resolved against MODULE_PANELS — every panel — while the
  // strip draws icons for a subset, so `sidebarTab` can legitimately name a
  // panel with no icon (Spatial, Transcript) that a command opened.
  //
  // U2: the app opens on FILES (the user: "make 'Files' default at opening";
  // it was History). `DEFAULT_PANEL` rather than the literal, because Files
  // leading the strip and Files opening the app are ONE fact — see
  // ModuleStrip's `slot`. Nothing persists this: `sidebarTab` is plain
  // component state with no storage behind it (the session restores documents
  // and the view, never the panel), so the rule is simply "first paint opens
  // Files" and there is no restored state to fight.
  const [sidebarTab, setSidebarTab] = useState<PanelId | null>(DEFAULT_PANEL);
  const activeTab = MODULE_PANELS.find((t) => t.id === sidebarTab) ?? null;
  const ActiveIcon = activeTab?.Icon ?? null;

  // F11-8: "Remix should only appear when a remix is created" — so the entry's
  // condition is the app's own notion of a remix document existing, read from
  // remixService's session map (`getRemixSession`, the same question RemixPanel
  // asks to decide it has something to show) over the OPEN documents. No new
  // flag: a session is created by `createRemix` and dropped by
  // `invalidateRemixSession`, which `closeDocumentFlow` already calls for the
  // remix and its source. `useRemixVersion()` is the subscription that makes it
  // reactive — that map is module state behind `useSyncExternalStore`, not
  // zustand, exactly as RemixPanel documents.
  useRemixVersion();
  const hasRemix = documents.some((d) => getRemixSession(d.id) !== null);

  // The one state the contextual entry can strand: the card is showing Remix
  // when the last remix document goes. It closes — leaving it open would strand
  // a card whose strip entry has just been taken away, and E2's rule is that a
  // closed card hands the column's width back to the waveform.
  useEffect(() => {
    if (sidebarTab === 'remix' && !hasRemix) setSidebarTab(null);
  }, [sidebarTab, hasRemix]);

  /**
   * U2-3 / lot C (C1/C3/M2, fix round 1) — what happens when the user leaves
   * a RUNNING pass's module, and why it is now background-and-continue
   * rather than a refusal.
   *
   * Before lot C, leaving unmounted the hosted dialog exactly as an app-level
   * unmount would. That was genuinely destructive: SEVEN of the eleven hosted
   * dialogs keep their pass in component state (`busy`, `progress`,
   * `liveResults`, `stageProgress`) paired with an unmount-cancel ref
   * (RemixDialog's `cancelledRef`, SeparateDialog's and TranscribeDialog's
   * `unmountedRef`, and the copies the two chains name after them) whose run
   * body reads `if (cancelledRef.current) return;` after its await and
   * DISCARDS the finished result — unmounting one did not background it, it
   * threw the pass away, minutes of inference, silently. The other two
   * (`TempoDialog`, `AlignTimingDialog`) went the other way and were worse:
   * with no cancel ref at all, unmounting mid-pass ORPHANED the result,
   * committing an edit and an undo entry to a document the user had walked
   * away from. T6-3 closed that gap by giving every one of the eleven the
   * same cancel-ref contract `runEffectOnSelection` reads between the audio
   * arriving and `applyEdit` writing it.
   *
   * `columnHost` (lot C) is what makes background-and-continue possible: a
   * module switch now only moves which retained host is FOREGROUNDED, never
   * which is RETAINED — the dialog stays mounted, its pass (if any) keeps
   * running, unseen but alive. M2 (decisions.md, USER): "switching views and
   * modules while a pass runs stays allowed — that is the whole point of lot
   * C. Only starting another pass is refused." So `refuseWhileRunning` below
   * no longer guards LEAVING; it guards STARTING A SECOND PASS while one
   * already holds `passLock.ts`'s app-wide lock (M1) — `openTool`/`openEffect`
   * call it when `anyHostPassRunning()`, and it is kept as App-level defence
   * in depth for the one caller left that bypasses the command registry
   * (`TranscriptPanel.tsx`'s "Transcribe again…" button reaches
   * `openTranscribeDialog` directly); every other door now reads its own
   * refusal off `isCommandEnabled`/`commandReason` before it ever calls in
   * here at all.
   *
   * The KEYBOARD stays live for the duration of a run (lot M / M6):
   * `dialogBus.hasOpenDialog()` narrows to the MODAL stack only, and the four
   * commands that could actually change which document a pass is pinned to —
   * `file.open`, `file.new`, `file.close`, `session.open` — are disabled with
   * a reason while the lock is held (`menuActions.ts`, decisions.md's M-c).
   * Everything else — Space, Ctrl+Z, Home/End, the bare letters lot H added,
   * the arrows, and now (lot C) the module strip itself — reaches its command
   * exactly as it would idle, because none of it can touch which document the
   * pass is pinned to.
   */
  const hostedToolRef = useRef<string | null>(null);
  hostedToolRef.current = hostedTool;
  // ---- lot B ----
  const hostedEffectRef = useRef<string | null>(null);
  hostedEffectRef.current = hostedEffect;
  // ---- /lot B ----
  // ---- lot C ----
  // Item 3 (C3, fix round 1) — the per-kind "is a pass running" signal,
  // replacing the single `toolRunningRef` a mutual-exclusion world could get
  // away with. Two independent slots (C5) can each hold their own pass
  // independently (never SIMULTANEOUSLY under lot M's app-wide lock — M1 is
  // one pass at a time — but a slot's OWN running flag still needs to survive
  // the OTHER slot's dialog mounting/unmounting around it), so `refuseWhileRunning`,
  // `describeHostedPass`, the badges (C4) and the guards below all read this
  // ref rather than re-deriving "which one is running" from whichever of
  // `hostedTool`/`hostedEffect` happens to be non-null (decisions.md's
  // "stale-label hazard": the two must never be able to name different
  // passes).
  const hostPassRef = useRef<{ tool: boolean; effect: boolean }>({ tool: false, effect: false });
  const anyHostPassRunning = () => hostPassRef.current.tool || hostPassRef.current.effect;
  // ---- /lot C ----
  // ---- lot M ----
  // Item 13 / M1/M4/M5: the release closures for whatever hosted pass
  // currently holds `passLock.ts`'s app-wide lock, one per retained slot
  // (lot C fix round 1, C5's two independent slots), or `null` when nothing
  // in that slot does.
  const passReleaseToolRef = useRef<null | (() => void)>(null);
  const passReleaseEffectRef = useRef<null | (() => void)>(null);

  /** Item 13 (M-a's evidence) / lot C fix round 1 — the running hosted
   * pass's own descriptor, resolved for ONE named slot rather than derived
   * tool-first from whichever of `hostedTool`/`hostedEffect` happens to be
   * set — two independent slots (C5) means "which one is running" cannot be
   * inferred from mere existence. Shared by `refuseWhileRunning` (the
   * message box) and `handleToolLock`/`handleEffectLock` (the lock) so
   * neither can ever name a different pass than the other. */
  const describeHostedPass = useCallback((kind: 'tool' | 'effect'): PassDescriptor => {
    if (kind === 'tool') {
      const pipeline = getPipelineGroups()
        .flatMap((g) => g.commands)
        .find((c) => c.id === hostedToolRef.current);
      if (pipeline) return { id: pipeline.id, label: pipeline.label, kind: 'pipeline' };
      return { id: 'pipeline.unknown', label: 'A pipeline pass', kind: 'pipeline' };
    }
    const effect = hostedEffectRef.current ? getEffect(hostedEffectRef.current) : undefined;
    if (effect) return { id: `effect.${effect.id}`, label: effect.name, kind: 'effect' };
    return { id: 'effect.unknown', label: 'An effect', kind: 'effect' };
  }, []);
  // ---- /lot M ----

  /** Lot C fix round 1 (C3) — the ONLY remaining caller of this message box
   * is `openTool`/`openEffect`, refusing to START a second pass while one
   * already holds the app-wide lock (M1). It no longer has anything to do
   * with LEAVING — see the docblock above `hostedToolRef`. Reads the SAME
   * `hostPassRef` slot `describeHostedPass` does, and composes the message
   * with `passBusyReason` (passLock.ts, M3's one canonical sentence) rather
   * than its own wording, so this box and a failed dialog-side acquire
   * (`handleToolLock`/`handleEffectLock` below) can never say different
   * things about the same running pass. */
  const refuseWhileRunning = useCallback(() => {
    const label = hostPassRef.current.tool
      ? describeHostedPass('tool').label
      : hostPassRef.current.effect
        ? describeHostedPass('effect').label
        : 'A pipeline pass';
    void window.electronAPI?.showMessageBox({
      type: 'info',
      title: 'A pass is running',
      message: passBusyReason(label),
    });
  }, [describeHostedPass]);

  /** U2-3: mount a pipeline tool in the module column, with the strip
   * showing Pipeline as the active module. Lot C (C5): no longer nulls
   * `hostedEffect` — the two are independent retained slots now; opening a
   * tool only ever replaces a PREVIOUSLY RETAINED TOOL (the component-type
   * swap `PipelineToolHost` does for a new command id does that for free),
   * never the effect card. */
  const openTool = useCallback(
    (commandId: string) => {
      if (anyHostPassRunning()) {
        refuseWhileRunning();
        return;
      }
      setSidebarTab('pipeline');
      setHostedTool(commandId);
      // Lot C (C1): the tool opens FOREGROUNDED — a fresh open is never
      // backgrounded on arrival.
      setColumnHost('tool');
      // Lot D (item 4) — opens a clip-scoped working copy when `commandId` is
      // one of the five hosted tools D1/D5 cover AND multitrack actually
      // names a valid clip target; a no-op (beyond releasing whatever was
      // open before) for every other command/view.
      beginClipWork(commandId);
    },
    [refuseWhileRunning]
  );

  /** U2-3 / lot C (C-j, fix round 1) — shared by `showPanel` and
   * `selectModule`: does the panel about to show have a retained host of its
   * OWN to foreground, or does it background whatever is currently
   * foregrounded? */
  const focusFor = (tab: PanelId | null): 'tool' | 'effect' | null =>
    tab === 'pipeline' && hostedToolRef.current !== null
      ? 'tool'
      : tab === 'effects' && hostedEffectRef.current !== null
        ? 'effect'
        : null;

  /**
   * U2-3 / lot C (C-j, fix round 1) — put a PANEL in the card. The three
   * `focus*Panel` bus entries land here.
   *
   * Before lot C this cleared the pipeline tool's own lock and unmounted it
   * unconditionally: a hand-off from a just-finished tool needed that
   * (`showPanel` used to run from inside the SAME synchronous handler that
   * had just set `busy` back to `false`, before React re-rendered
   * `dismissable`), and `focusSpatialPanel` (a user's menu pick,
   * `spatial.position`) was guarded against doing the same thing mid-run.
   * M2 ("switching views and modules while a pass runs stays allowed — that
   * is the whole point of lot C") removes the reason for either: nothing
   * here unmounts anything or releases a lock any more (C-j — "neither
   * `showPanel` nor `selectModule` may call M's `passRelease*`. Only
   * `closeTool` / `closeEffect` ... and `DialogShell`'s own cleanup
   * release"). A hand-off's own `onClose()` — which DOES call
   * `closeTool`/`closeEffect` — is what actually releases the lock, same as
   * it always was, in the same synchronous handler; and `focusSpatialPanel`
   * now backgrounds a running tool instead of being refused, the same
   * "background, don't discard" promise C1 makes everywhere else. This is
   * also what fixes the THIRD caller decisions.md's C-j names —
   * `edit.transcribe`'s mouse-driven reveal arm (`menuActions.ts`): it used
   * to silently destroy whatever tool was open; now it backgrounds it.
   */
  const showPanel = useCallback((panel: PanelId) => {
    setSidebarTab(panel);
    setColumnHost(focusFor(panel));
  }, []);

  /** U2-3: the host's own dismissal — the ONLY thing, besides `DialogShell`'s
   * own unmount cleanup, that releases the tool's slot of the pass lock. */
  const closeTool = useCallback(() => {
    hostPassRef.current.tool = false;
    passReleaseToolRef.current?.();
    passReleaseToolRef.current = null;
    setHostedTool(null);
    // Lot C: only clear the column when THIS host owned it.
    setColumnHost((c) => (c === 'tool' ? null : c));
    // Lot D (item 4) — the tool's own dismissal releases its clip-work slot,
    // discarding an uncommitted working copy and restoring the view state it
    // captured (a no-op when this tool never opened one).
    endClipWork();
  }, []);

  /**
   * U2-3 / lot C (C1/C2/C-d, fix round 1) — the strip's own selection.
   *
   * Before this lot, ANY click here nulled `hostedTool` — a module switch
   * destroyed whatever pipeline tool was open. Lot C stops that: the
   * retained hosts (`hostedTool`/`hostedEffect`, unaffected by this function)
   * stay mounted, and only `columnHost` — which one is FOREGROUNDED — moves.
   * The strip is no longer disabled while a pass runs either (C3/M2), so
   * this is now reachable mid-pass too — harmless, since it only ever moves
   * `columnHost`/`sidebarTab`, never a lock or a mount.
   *
   * C-d: `ModuleStrip` is unchanged — it still sends `onSelect(isActive ?
   * null : id)`. A click on the ALREADY-active module (`tab === null`)
   * either backgrounds that module's host (if one is foregrounded there) so
   * its chooser panel appears, or — a SECOND such click, with nothing left
   * to background — closes the module card itself, exactly as before this
   * lot.
   */
  const selectModule = useCallback((tab: PanelId | null) => {
    if (tab === null) {
      if (columnHostRef.current !== null) {
        setColumnHost(null);
        return;
      }
      setSidebarTab(null);
      return;
    }
    setSidebarTab(tab);
    setColumnHost(focusFor(tab));
  }, []);

  /**
   * U2-3 / lot C (fix round 1) — the hosted dialogs' module LOCK, arriving
   * through the shell — normally `!dismissable`, narrower for a tool that
   * starts something on mount (see `DialogShell`'s `moduleLock`).
   *
   * Lot C splits this into TWO stable callbacks, one per retained slot: C5's
   * two independent slots need two independent lock/acquire/release
   * lifecycles — a running effect alongside a retained-but-idle tool, or
   * vice versa, must not share one ref. Each is ALSO the ONE seam that
   * acquires/releases `passLock.ts`'s app-wide lock for its own kind
   * (M1/M4/M5, unchanged from lot M: the eleven dialogs never call
   * `runExclusivePass` themselves, they keep publishing through this exact
   * callback and it is turned into `acquire` on `true` / `release` on
   * `false`). The acquire is idempotent (skipped once the slot's own release
   * ref is already set); the optional-chained release is idempotent the same
   * way `passLock.acquirePass`'s own closure already is — so a release that
   * already ran (from `closeTool`/`closeEffect`, or from the unmount effect
   * below) is always safe to call again.
   *
   * Fix round 3 (item 1, lot M) — the defence-in-depth half of "dialogs
   * consult the lock": a `null` acquire (a FOREIGN pass already holding the
   * lock) names the pass that actually holds it (`blockedByPassReason()`,
   * never `describeHostedPass()` — that would name the dialog ABOUT to run,
   * not the one blocking it).
   */
  const handleToolLock = useCallback(
    (running: boolean) => {
      hostPassRef.current.tool = running;
      if (running) {
        if (passReleaseToolRef.current === null) {
          const release = acquirePass(describeHostedPass('tool'));
          if (release === null) {
            void window.electronAPI?.showMessageBox({
              type: 'info',
              title: 'A pass is running',
              message: blockedByPassReason() ?? 'A pass is running.',
            });
          } else {
            passReleaseToolRef.current = release;
          }
        }
      } else {
        passReleaseToolRef.current?.();
        passReleaseToolRef.current = null;
      }
    },
    [describeHostedPass]
  );

  /** Lot C fix round 1 — the effect card's own copy of `handleToolLock`,
   * publishing to `passReleaseEffectRef`/`hostPassRef.current.effect`
   * instead. See that callback's docblock for the full mechanism. */
  const handleEffectLock = useCallback(
    (running: boolean) => {
      hostPassRef.current.effect = running;
      if (running) {
        if (passReleaseEffectRef.current === null) {
          const release = acquirePass(describeHostedPass('effect'));
          if (release === null) {
            void window.electronAPI?.showMessageBox({
              type: 'info',
              title: 'A pass is running',
              message: blockedByPassReason() ?? 'A pass is running.',
            });
          } else {
            passReleaseEffectRef.current = release;
          }
        }
      } else {
        passReleaseEffectRef.current?.();
        passReleaseEffectRef.current = null;
      }
    },
    [describeHostedPass]
  );

  // Lot M (M5) — the THIRD release guarantee, on top of the eleven dialogs'
  // own `finally` blocks and `DialogShell`'s unmount cleanup: if App itself
  // unmounts mid-pass (a full app teardown, not a background/foreground
  // toggle — this effect is `[]`-scoped precisely so nothing else can fire
  // it), the lock must not outlive the render tree that was going to release
  // it. A stale hold here would wedge every OTHER window/session permanently,
  // which is the failure mode M5 exists to rule out. Lot C fix round 1:
  // releases BOTH retained slots now, not just the tool's.
  //
  // Fix round 2 — a recording release alongside it, for the SAME reason:
  // `multitrackRecorder`'s own lock hold (see `multitrackRecord.ts`) is
  // released from inside its `stop()`, which nothing here calls
  // automatically on unmount otherwise — the view-switch effect above only
  // fires on a CHANGE, never on teardown.
  //
  // Fix round 3 (item 5) — narrowed to `multitrackRecorder.stop()` behind an
  // `isRecording()` guard, NOT the broader `stopAll()` fix round 2 first
  // reached for. `stopAll()` also stops `playbackEngine`/`multitrackPlayer`
  // unconditionally, which is a new, unpinned side effect on EVERY App
  // unmount — including every React Testing Library teardown of a test that
  // happened to leave playback running — that nothing asked for and nothing
  // tested. This guard is exactly the shape `transportStop()` already uses
  // (`if (multitrackRecorder.isRecording()) void multitrackRecorder.stop();`),
  // so it stops only what fix round 2 was actually about: a take mid-record
  // when the whole tree tears down. The zustand stores `stop()` writes into
  // outlive the React tree, so the take's async commit still lands correctly
  // even after this component is gone.
  useEffect(() => {
    return () => {
      passReleaseToolRef.current?.();
      passReleaseToolRef.current = null;
      passReleaseEffectRef.current?.();
      passReleaseEffectRef.current = null;
      if (multitrackRecorder.isRecording()) void multitrackRecorder.stop();
    };
  }, []);

  // ---- lot D ----
  // Item 4 — the structural THIRD release (Risk 1), alongside `beginClipWork`'s
  // own leading `endClipWork()` and `closeTool`/`closeEffect`: if App itself
  // unmounts with a clip-work slot open, the working document and its store
  // subscription must not outlive the render tree, the same guarantee lot M's
  // pass-lock release above already makes for the two module locks.
  useEffect(() => {
    return () => endClipWork();
  }, []);
  // ---- /lot D ----

  // ---- lot B ----
  /**
   * Item 6 / M6 / N16 / lot C (C5, fix round 1) — host an effect in the
   * module column, as a card between the strip and the module card, with
   * that card forced to Effects so the other effects stay one click away.
   * The effect publishes its own lock through `handleEffectLock` (its own
   * slot, its own release ref) — a running pass, a tool's OR an effect's
   * Apply, is never discarded. Lot C (C5): no longer nulls `hostedTool` —
   * see `openTool`'s own comment; the two are independent retained slots.
   */
  const openEffect = useCallback(
    (effectId: string) => {
      if (anyHostPassRunning()) {
        refuseWhileRunning();
        return;
      }
      setSidebarTab('effects'); // N16 / M6: the module card is forced to Effects
      setHostedEffect(effectId);
      // Lot C (C1): opens FOREGROUNDED, same as `openTool`.
      setColumnHost('effect');
      // Lot D (item 4) — the effect card has no command id of its own
      // (`effect.<id>` is per-registered-effect); `EFFECT_CARD_WORK_ID` is
      // its slot key. Same qualification as `openTool`: a no-op outside
      // multitrack or with no valid clip target.
      beginClipWork(EFFECT_CARD_WORK_ID);
    },
    [refuseWhileRunning]
  );
  const closeEffect = useCallback(() => {
    hostPassRef.current.effect = false;
    passReleaseEffectRef.current?.();
    passReleaseEffectRef.current = null;
    setHostedEffect(null);
    // Lot C: only clear the column when THIS host owned it — `openTool` may
    // already have taken over by the time this runs.
    setColumnHost((c) => (c === 'effect' ? null : c));
    // Lot D (item 4) — see `closeTool`'s identical comment.
    endClipWork();
  }, []);
  // ---- lot C ----
  // Item 3 (C-i, fix round 1) — the orphan rule, now covering BOTH retained
  // slots in one effect (C5 lets both be retained at once): no document left
  // means nothing for either card to apply to, so both close and
  // `columnHost` resets. One document closing while another becomes active
  // keeps them — the dialogs resolve the live active document at Apply,
  // exactly as the modal era did.
  useEffect(() => {
    if (activeDocumentId !== null) return;
    if (hostedEffect !== null) setHostedEffect(null);
    if (hostedTool !== null) setHostedTool(null);
    setColumnHost(null);
  }, [hostedEffect, hostedTool, activeDocumentId]);
  // ---- /lot C ----
  // ---- /lot B ----

  // Global keyboard shortcuts (Task 8): mounted once for the app's lifetime.
  useEffect(() => installShortcuts(window), []);

  // F11: the window-level FILE-drop guard.
  //
  // What this is honestly for. `navigateOnDragDrop` — the webPreferences flag
  // that would make Chromium navigate to a dropped file, replacing the whole
  // app with a file viewer — has defaulted to FALSE since Electron 3, and
  // `electron/main.cjs` never sets it. So the catastrophe this guard was
  // originally justified by is not currently reachable. It stays because the
  // insurance costs one condition and the failure mode it covers is total: if
  // that flag is ever flipped, or a future Electron changes its default back,
  // a near miss on a track lane would silently discard every open document.
  //
  // What it must NOT do is fire on anything else. The first version refused
  // EVERY drop, and the default action it was suppressing for text drags is
  // the one that inserts the text into a text control — which silently broke
  // dragging text into the lyrics, remix, voice-changer and properties fields.
  // Gating on `types` restores all of them: a text drag carries `text/plain`,
  // a clip drag carries our own MIME, and neither carries `Files`.
  //
  // It is not a competing drop handler: it reads one field and imports nothing.
  // The lane handlers are React listeners on the root container, inside
  // `window`, so they have already run by the time this fires.
  //
  // `dragover` gets the same condition, because a `drop` whose `dragover` was
  // not prevented never fires at all — treating the two differently would make
  // the guard's own behaviour depend on which half ran.
  useEffect(() => {
    const refuseFiles = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', refuseFiles);
    window.addEventListener('drop', refuseFiles);
    return () => {
      window.removeEventListener('dragover', refuseFiles);
      window.removeEventListener('drop', refuseFiles);
    };
  }, []);

  // Switching views mid-playback otherwise orphans whichever engine was
  // playing (transportStop() only routes to the CURRENT view's engine) — stop
  // BOTH engines whenever the view changes. Skips the initial mount (there is
  // nothing to stop yet, and stopAll() is idempotent/no-op-safe regardless).
  const prevViewRef = useRef(view);
  useEffect(() => {
    if (prevViewRef.current !== view) {
      stopAll();
    }
    prevViewRef.current = view;
  }, [view]);

  // Let the file.new / file.export commands open these React dialogs (Task 11).
  //
  // U2-3: the nine pipeline openers no longer raise a modal flag. They name the
  // command whose tool the module column should HOST, and every door the user
  // has — the Pipeline card and the Pipeline menu — arrives here, because both
  // go through `runCommand` and every one of those commands' `run()` bodies
  // calls one of these openers. Routing at the bus is what made "from every
  // door" one change rather than several. Item 6 gives `openEffectDialog` the
  // same shape: the Effects card's rows and the Effects menu both land on
  // `openEffect`, which hosts the effect in the column.
  useEffect(
    () =>
      registerDialogSetters({
        openNewFileDialog: () => setNewFileOpen(true),
        openExportDialog: () => setExportOpen(true),
        openEffectDialog: openEffect,
        openConvertDialog: (mode) => setConvertMode(mode),
        openRecordDialog: () => setRecordOpen(true),
        openTempoDialog: () => openTool('tempo.match'),
        openRemixDialog: () => openTool('edit.remix'),
        // D4: one bus entry, two rows — the mode picks which of them the host
        // mounts, and the dialog reads its own mode off that id.
        openSeparateDialog: (mode) =>
          openTool(mode === 'voice' ? 'voice.separate' : 'edit.separateStems'),
        openTranscribeDialog: () => openTool('edit.transcribe'),
        openVoiceChangerDialog: () => openTool('edit.voiceChanger'),
        openAlignTimingDialog: () => openTool('timing.align'),
        openVocalChainDialog: () => openTool('effects.vocalChain'),
        openCoverChainDialog: () => openTool('effects.coverChain'),
        openPodcastChainDialog: () => openTool('effects.podcastChain'),
        openAlignLyricsDialog: () => openTool('lyrics.align'),
        // U2-3: hand-offs from a tool that has just finished.
        focusRemixPanel: () => showPanel('remix'),
        focusTranscriptPanel: () => showPanel('transcript'),
        // F11-8: the Mix command's only effect (Effects > Mix since T8,
        // Pipeline > Mix before it). Spatial is a single
        // tool rather than a module (user ruling), so this is how its panel
        // reaches the card now that the strip draws no icon for it.
        // Lot C (C3/M2, fix round 1): no longer guarded — switching module
        // mid-pass is allowed everywhere now, so this just backgrounds
        // whatever was foregrounded, exactly like every other `showPanel` call.
        focusSpatialPanel: () => showPanel('spatial'),
      }),
    [openTool, showPanel, openEffect]
  );

  // Scripted-smoke test hooks — only when the preload flagged test mode.
  useEffect(() => {
    if ((window as unknown as { __auditoriumTest?: boolean }).__auditoriumTest) {
      installTestHooks();
    }
  }, []);

  // Native close guard (Task F8, replaces the old beforeunload handler): main
  // intercepts the window's 'close' event and asks how many documents would
  // lose work; we answer with the count read at REQUEST time (getState, not a
  // stale render closure). Main then closes silently (0) or shows a native
  // Quit/Cancel box. See electron/closeGuard.cjs.
  //
  // The busy count is saves-in-flight PLUS any in-flight stem separation
  // (Task S3, ruling 7): a separation is minutes of inference the user cannot
  // get back, so quitting mid-run must warn rather than discard it silently.
  //
  // The count is the PROJECT's (lot A, M4/N12 — `projectDirtyCount`): each
  // document with `dirty || neverSaved` (Task S4: a computed document — Mix
  // Down, Remix N, a recording, a stem — is CLEAN from birth, so counting
  // `dirty` alone let Quit discard the whole thing without asking), plus one
  // for a dirty session, and at least one for a project that has content but
  // has never been written; an empty untitled project is clean. The busy
  // count also carries an in-flight PROJECT save.
  //
  // Lot B deliberately diverges here: the per-document close (closeDocumentFlow)
  // dropped `neverSaved` from its own predicate, but this quit count keeps it
  // (B4) — closing one document is a deliberate act, quitting is not, and the
  // quit guard still warns when unsaved computed audio would be lost.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onCloseRequested) return; // jsdom / older preload
    return api.onCloseRequested(() => {
      api.respondCloseRequest(
        projectDirtyCount(),
        getInFlightSaveCount() +
          (isProjectSaveInFlight() ? 1 : 0) +
          getStemBusyCount() +
          getTranscribeBusyCount() +
          getDiarizeBusyCount() +
          getVoiceBusyCount() +
          getAlignBusyCount()
      );
    });
  }, []);

  // ---- lot C ----
  // Item 3 (C4) — one strip badge per host that is RETAINED but not
  // foregrounded. `running` reads lot M's lock directly, compared by
  // descriptor id — never a parallel "is it running" flag (the badge and
  // `refuseWhileRunning`/`describeHostedPass` above must never be able to
  // name different passes). The id shapes mirror `describeHostedPass`: a
  // pipeline command id for the tool, `effect.<id>` for the effect.
  const runningPass = usePassLock();
  const hostBadges: { tab: PanelId; label: string; running: boolean }[] = [];
  if (hostedTool !== null && columnHost !== 'tool') {
    const toolLabel =
      getPipelineGroups()
        .flatMap((g) => g.commands)
        .find((c) => c.id === hostedTool)?.label ?? 'A pipeline pass';
    hostBadges.push({ tab: 'pipeline', label: toolLabel, running: runningPass?.id === hostedTool });
  }
  if (hostedEffect !== null && columnHost !== 'effect') {
    const effectLabel = getEffect(hostedEffect)?.name ?? 'An effect';
    hostBadges.push({
      tab: 'effects',
      label: effectLabel,
      running: runningPass?.id === `effect.${hostedEffect}`,
    });
  }
  // ---- /lot C ----

  return (
    <div
      data-testid="app-root"
      className="flex h-screen w-screen flex-col bg-[#1a1a1e] text-[#d4d4d8]"
    >
      <TitleBar />
      {/* G6: the editor canvas IS the stage — one relative surface carrying
          the radial --canvas-bg with the active view in flow (each view roots
          itself with .stage-inset clearance) and every piece of chrome
          floating over it as an absolute z-20 overlay: the G3 toolbar band
          (pill + file chip), the G4 card column and icon rail, and the G2
          status pill. Z-order: dialogs (DialogShell, fixed z-40) above
          chrome (z-20) above lanes (in-flow). The titlebar's menu dropdowns
          sit at z-50 in their own band above everything, as before. */}
      <div
        data-testid="editor-stage"
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
        style={
          {
            backgroundImage: 'var(--canvas-bg)',
            // U1 (layout E2): the stage's horizontal clearance, published as
            // tokens so THREE surfaces stay on one axis without measuring
            // anything — the editor views' `.stage-inset`, the toolbar band
            // and the bottom band, which centre themselves on the stage box by
            // padding rather than on the window. The right value collapses
            // when no panel card is open, and every one of them follows in the
            // same layout pass. The TEMPO card keeps floating top-right in the
            // collapsed state (it is chrome over the stage, exactly like the
            // toolbar, status and edit pills) rather than holding 362px of
            // width hostage for a 90px card.
            '--stage-inset-left': `${COLUMN_MARGIN}px`,
            // U2-3: four states now — no card, a module card, the wider tool
            // host, and (item 6 / M6) an effect card with or without a module
            // card beneath it. The effect card is the column's own width, so
            // it asks for a module card's clearance; it can outlive the module
            // card, which is why it is its own clause.
            // Lot C: follows `columnHost` (what is FOREGROUNDED) rather than
            // mere existence (`hostedTool !== null`) — a backgrounded tool
            // must hand the 640 clearance back, not keep reserving it.
            '--stage-inset-right': `${
              columnHost === 'tool'
                ? STAGE_INSET_RIGHT_HOSTED
                : sidebarTab === null && columnHost !== 'effect'
                  ? COLUMN_MARGIN
                  : STAGE_INSET_RIGHT_OPEN
            }px`,
          } as CSSProperties
        }
      >
        {view === 'multitrack' ? (
          <MultitrackView />
        ) : doc && view === 'spectral' ? (
          // F11-0: the ID, never the document — a 65 MiB object graph in a
          // prop wedged React 19's dev profiler permanently (see
          // src/dev/userTimingGuard.ts).
          <SpectrogramView docId={doc.id} />
        ) : doc ? (
          <WaveformView docId={doc.id} />
        ) : (
          <div
            className="flex flex-1 items-center justify-center text-center"
            style={{ color: 'var(--glass-text-muted)' }}
          >
            Open an audio file (Ctrl+O) or create a new one (Ctrl+N)
          </div>
        )}

        {/* G3 toolbar band: transport/view/zoom pill + file chip, floating
            top-centre / top-left (mockup `.toolbar` / `.filechip`). */}
        <Toolbar />

        {/* G4 card column (mockup `.col`, 348px), floating top-right: the
            persistent TEMPO card (hidden until an analysis exists) above ONE
            glass panel card for the strip's active entry. The card hugs its
            content and scrolls internally when it outgrows the column
            (scroll containment preserved). The wrapper ignores pointer
            events so the empty column strip never blocks the stage. Top is
            68 (the stage-inset top), NOT the toolbar-band top: the strip now
            occupies the band's right end, and the column stacks beneath it
            aligned with the lanes.

            U1: the column moved from `right: 84` to the window's own 14px
            margin — the 72px the vertical rail used to hold at the edge is
            waveform now. */}
        <div
          className="pointer-events-none absolute z-20 flex flex-col"
          style={{
            top: 68,
            right: COLUMN_MARGIN,
            bottom: 58,
            width: MODULE_COLUMN_WIDTH,
            gap: 14,
          }}
        >
          <TempoCard />
          {/* ---- lot B ----
              Item 6 / M6: the effect card sits between the strip (and the
              TempoCard) and the module card — same width as both, so the
              strip never learns a third width (W1). It does not replace the
              module card: that card is forced to Effects when the effect
              opens (N16) and then lives its own life beneath. */}
          {hostedEffect !== null && (
            <EffectHost
              effectId={hostedEffect}
              // Lot C (C1/C2/C-e): stays MOUNTED across a module switch now —
              // only its visibility follows `columnHost`.
              backgrounded={columnHost !== 'effect'}
              onClose={closeEffect}
              onModuleLockChange={handleEffectLock}
            />
          )}
          {/* ---- /lot B ---- */}
          {/* U2-3: the tool host REPLACES the module card while it is the
              FOREGROUNDED surface — same anchor, same glass language, wider.
              No backdrop and no focus trap: the stage behind it stays live,
              which is the whole point (watch the stepper beside the
              waveform). Lot C: it now stays MOUNTED (hidden) rather than
              unmounting when another module is picked — `hostedTool !== null`
              (retained) and `columnHost === 'tool'` (foregrounded) are no
              longer the same question. */}
          {hostedTool !== null && (
            <PipelineToolHost
              commandId={hostedTool}
              backgrounded={columnHost !== 'tool'}
              onClose={closeTool}
              onModuleLockChange={handleToolLock}
            />
          )}
          {columnHost !== 'tool' && (
            activeTab &&
            ActiveIcon && (
            <GlassCard
              data-testid="sidebar-panel"
              data-active-tab={activeTab.id}
              className="pointer-events-auto flex min-h-0 flex-col"
              style={{ flex: '0 1 auto', overflow: 'hidden' }}
            >
              <div
                className="flex shrink-0 items-center"
                style={{
                  padding: '13px 16px',
                  gap: 11,
                  background: 'rgba(0,0,0,.3)',
                  borderBottom: '1px solid var(--glass-border)',
                }}
              >
                <IconTile>
                  <ActiveIcon size={15} />
                </IconTile>
                <span
                  className="min-w-0 flex-1 truncate"
                  style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--glass-text-title)' }}
                >
                  {activeTab.label}
                </span>
                {/* F11-8: the card closes from its own header. Until now the
                    strip's active entry was the ONLY way to close it — which
                    stops being true the moment a card can show a panel the
                    strip draws no icon for (Spatial, Transcript, and Remix
                    after its last remix document goes). One rule for every
                    panel rather than a conditional control: a card you opened
                    is a card you can close, wherever you opened it from. */}
                <button
                  type="button"
                  data-testid="sidebar-panel-close"
                  aria-label={`Close the ${activeTab.label} panel`}
                  title="Close this panel"
                  onClick={() => setSidebarTab(null)}
                  className="glass-rail-btn flex shrink-0 items-center justify-center"
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 7,
                    border: '1px solid transparent',
                    background: 'transparent',
                    color: 'var(--glass-text-chrome-idle)',
                    cursor: 'pointer',
                  }}
                >
                  <X size={13} />
                </button>
              </div>
              <div className="min-h-0 overflow-auto">
                {sidebarTab === 'files' && <FilesPanel />}
                {sidebarTab === 'effects' && <EffectsPanel />}
                {/* U2: the new module. */}
                {sidebarTab === 'pipeline' && <PipelinePanel />}
                {sidebarTab === 'history' && <HistoryPanel />}
                {sidebarTab === 'markers' && <MarkersPanel />}
                {sidebarTab === 'properties' && <PropertiesPanel />}
                {sidebarTab === 'remix' && <RemixPanel />}
                {sidebarTab === 'spatial' && <SpatialPanel />}
                {sidebarTab === 'transcript' && <TranscriptPanel />}
              </div>
            </GlassCard>
            )
          )}
        </div>

        {/* U1: the module strip — the G4 icon rail rotated horizontal, sitting
            in the toolbar band at the column's width and driving the card
            below it.

            Lot C (C3/C-c, fix round 1): the strip is never locked again —
            M2 ("switching views and modules while a pass runs stays allowed")
            deletes the `lockedReason` prop entirely; a backgrounded host with
            a running pass shows through `hostBadges` (C4) instead.

            W1: `toolHosted` widens the strip to the host card's own width
            while a tool is FOREGROUNDED — the user's rule that the bar and
            the open module are never unequal. */}
        <ModuleStrip
          activeTab={sidebarTab}
          hasRemix={hasRemix}
          toolHosted={columnHost === 'tool'}
          hostBadges={hostBadges}
          onSelect={selectModule}
        />

        {/* U1 bottom band (mockup E2): the edit pill floating ABOVE the G2
            status pill, both centred on the WAVEFORM's axis rather than the
            window's — the stage-inset tokens do the centring as padding, so
            opening or closing the module card re-centres both in the same
            layout pass. A flex COLUMN owns the 16px of clear air between
            them, so they read as two things (mockup E2's spacing, against
            option A's touching stack) whatever either pill's content does to
            its height. The edit pill renders nothing in the empty app, and
            the column collapses to the status pill alone. */}
        <div
          className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex flex-col items-center"
          style={{
            gap: 16,
            paddingLeft: 'var(--stage-inset-left)',
            paddingRight: 'var(--stage-inset-right)',
          }}
        >
          <EditToolbar />
          <StatusBar />
        </div>
      </div>

      {newFileOpen && <NewFileDialog onClose={() => setNewFileOpen(false)} />}
      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
      {convertMode && (
        <ConvertDialog mode={convertMode} onClose={() => setConvertMode(null)} />
      )}
      {recordOpen && <RecordDialog onClose={() => setRecordOpen(false)} />}
      {/* U2-3: the nine pipeline tools used to be mounted here, each behind its
          own `useState` flag, each raising a full-screen backdrop. They are in
          the module column now (see the card column above). Item 6 moved the
          per-effect parameter dialog there too (`EffectHost`): an effect is
          previewed against the stage, which is something to watch. What stays
          modal is the set that is a QUESTION rather than a workspace: New
          File, Export, Convert and Record each take one answer and close, and
          none of them has anything to watch on the stage while it is open. */}
    </div>
  );
}
