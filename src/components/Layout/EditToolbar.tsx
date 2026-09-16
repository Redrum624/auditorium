import { useCallback, useState, type CSSProperties } from 'react';
import {
  ClipboardPaste,
  Copy,
  Crop,
  Merge,
  Redo2,
  Scissors,
  SquareDashed,
  Trash2,
  Undo2,
  VolumeX,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { isCommandEnabled, runCommand } from '../../services/menuActions';
import { useHistoryVersion } from '../../services/undoHistory';
import { useAppStore } from '../../stores/appStore';
import { useSessionStore } from '../../multitrack/sessionStore';
import { ChromePill } from '../UI/glass';

/**
 * U1 (layout E2, element 5): the edit toolbar — icons only, its own glass
 * pill, floating above the bottom bar on the waveform's axis (App owns the
 * band and the 16px of clear air between the two).
 *
 * It adds NO edit logic. Every button is an id handed to `runCommand`, and
 * every enabled state is that command's OWN predicate read through
 * `isCommandEnabled` — the same function object the Edit menu evaluates. A
 * button that looks live but is stale therefore still cannot fire: runCommand
 * re-checks enablement before running, so the registry is the single gate.
 *
 * Visibility (the user's rule, final): present in Waveform, Spectral AND
 * Multitrack whenever at least one sound file is loaded; hidden only in the
 * empty app. Per-button greying does the rest — no selection greys
 * Copy/Delete/Trim/Silence, an empty clipboard greys Paste, and Undo/Redo
 * follow whichever history is active (`edit.undo`'s predicate already routes
 * to the SESSION's history in the multitrack view and the document's
 * elsewhere, which is exactly the rule wanted here).
 *
 * F1 / M1 / M7 / D6 — what the Multitrack view does to these ten:
 *  - Select All (H8, lot H) is one command routed by view — the whole file in
 *    the editors, every clip on every track in Multitrack — so it is never
 *    blocked there and carries no `multitrackReason`.
 *  - Split is ROUTED by view, not blocked: a marker at the cursor in the
 *    editors, a clip split at the edit cursor in the Multitrack (M1). Its
 *    tooltip follows the route, since the same button does two different
 *    things.
 *  - Join (D6, renamed from Merge — H1) is the M7 rule pointing the OTHER
 *    way: it is the one button that exists only in the Multitrack view, so
 *    the tooltip naming the view that CAN do it is its `title` — the EDITOR
 *    one — and `multitrackTitle` describes the verb. No new field: `title`
 *    already serves that side.
 *  - Delete is routed too, and always was: it removes the selected clips there.
 *  - Copy and Paste (lot L, items 11/12) are ROUTED too, like Split and
 *    Delete: a clip selection and the multitrack clip clipboard in that
 *    view, a document region in the editors. They used to stay
 *    unconditionally greyed with `multitrackReason: 'needs a clip
 *    clipboard'` — true until lot L built that clipboard. Each now carries a
 *    `multitrackTitle` naming what it does there, and greys or lights
 *    exactly as `edit.split`'s own button does, on the command's OWN
 *    predicate (`canCopyClips`/`pasteBlockReason`, `menuActions.ts`).
 *  - Trim and Silence (lot J, item 10) are ROUTED too, like Split and Delete:
 *    a swept multitrack time range in that view, a document region in the
 *    editors. They used to stay unconditionally greyed with `multitrackReason:
 *    'needs a time selection'` — true until lot J built the `Shift`+drag
 *    sweep that IS one. Each now carries a `multitrackTitle` naming the
 *    gesture (J9's compensation for not also wiring Ctrl+A/Select All to it),
 *    and greys or lights exactly as `edit.split`'s own button does, on the
 *    command's OWN predicate.
 * The gate itself lives in the registry so the menu and the keyboard obey it
 * too; this component only chooses the tooltip that explains a greying (or a
 * different meaning) the predicate has already decided, because a missing
 * button teaches nothing.
 */

export interface EditToolbarItem {
  label: string;
  commandId: string;
  Icon: LucideIcon;
  /** Starts a new group in the pill (renders a divider before it). */
  startsGroup?: boolean;
  /** Why this button is greyed in the Multitrack view — see the note above.
   * Drives the explanatory tooltip ONLY; enablement comes from the command. */
  multitrackReason?: string;
  /** The tooltip in the Multitrack view for a button whose command means
   * something ELSE there (Split, Join, Trim, Silence), rather than nothing. */
  multitrackTitle?: string;
  title: string;
}

/** Select All │ Split · Join · Copy · Paste · Delete │ Trim · Silence │ Undo ·
 * Redo — H8/H5's four groups, in order, on lucide line icons (the app's rule:
 * never emoji). Exported so the tests name the same ten the pill draws. */
export const EDIT_TOOLBAR_ITEMS: EditToolbarItem[] = [
  {
    // H4/H8 (lot H) — Select All is a SELECTION verb, not an edit acting on
    // one, so it leads its own group rather than joining the four that act on
    // a standing selection (H8's reasoning). One view-routed command, same as
    // Split: the whole file in the editors, every clip on every track in
    // Multitrack (H8) — never blocked there, so no `multitrackReason`.
    label: 'Select All',
    commandId: 'edit.selectAll',
    Icon: SquareDashed,
    title: 'Select All (A or Ctrl+A) — the whole file',
    multitrackTitle: 'Select All (A or Ctrl+A) — every clip on every track',
  },
  {
    // H5 (lot H) — Select All above draws the FIRST divider, so Split now
    // starts the group that used to open with no divider.
    startsGroup: true,
    label: 'Split',
    commandId: 'edit.split',
    Icon: Scissors,
    title: 'Split at Cursor (C or Ctrl+K) — a marker at the cursor, or at both edges of the selection',
    multitrackTitle:
      'Split at Cursor (C or Ctrl+K) — cuts every clip under the cursor on the selected clips’ tracks',
  },
  {
    // D6 — directly after Split, the verb it undoes. Blocked in the editors
    // rather than in Multitrack, so its `title` carries the M7 sentence.
    // H1 (lot H) — renamed "Join Clips" everywhere the user can see it, and
    // now bound to the bare `J` (H2: `M` stays Add Marker, so Join could not
    // take it). The lucide icon name (`Merge`) is not user-visible and is
    // unchanged.
    label: 'Join',
    commandId: 'multitrack.joinClips',
    Icon: Merge,
    title:
      'Join Clips (J) — not available in the Waveform and Spectral views: it joins the selected clips of a multitrack track into one. Switch to Multitrack to use it.',
    multitrackTitle:
      'Join Clips (J) — joins the selected clips on each track into one clip, silence in the gaps',
  },
  {
    // Lot L (item 12) — routed, not blocked: copies the selected clips.
    label: 'Copy',
    commandId: 'edit.copy',
    Icon: Copy,
    title: 'Copy (Ctrl+C)',
    multitrackTitle: 'Copy (Ctrl+C) — copies the selected clips',
  },
  {
    // Lot L (item 12) — routed, not blocked: drops the copied clips to the
    // right of the bar, on the current track (click a track's background to
    // choose it — K2/K3).
    label: 'Paste',
    commandId: 'edit.paste',
    Icon: ClipboardPaste,
    title: 'Paste (Ctrl+V)',
    multitrackTitle:
      'Paste (Ctrl+V) — drops the copied clips to the right of the bar, on the current track (click a track’s background to choose it)',
  },
  {
    label: 'Delete',
    commandId: 'edit.delete',
    Icon: Trash2,
    title: 'Delete (D or Del)',
    // D3 — in the multitrack Delete has two jobs, and a button that does two
    // things has to name both: it removes the selected clips, or, when the
    // selection is a GAP (double-click empty lane space), closes it — every
    // clip after it on THAT track moves up by the gap's length.
    multitrackTitle:
      'Delete (D or Del) — removes the selected clips, or closes the selected gap: the clips after it on that track move up',
  },
  {
    // Lot J (item 10) — Trim now WORKS in Multitrack (a swept time range,
    // not a document region), so it drops `multitrackReason` — the button is
    // no longer unconditionally blocked there — and gains `multitrackTitle`,
    // the `edit.split`/`multitrack.joinClips` shape: what the SAME command
    // does in this OTHER view. J9's compensation for the discoverability
    // ruling (Ctrl+A does not also set the range): the tooltip names the
    // gesture rather than only the greyed reason.
    label: 'Trim',
    commandId: 'edit.trim',
    Icon: Crop,
    startsGroup: true,
    title: 'Trim to Selection (T) — keeps the selected region, drops the rest',
    multitrackTitle:
      'Trim to Selection — keeps only the swept time range on the selected clips’ tracks (all tracks with nothing selected). Shift+drag a lane to sweep a range.',
  },
  {
    label: 'Silence',
    commandId: 'edit.silence',
    Icon: VolumeX,
    title: 'Silence Selection (S) — zeroes the selected region in place',
    multitrackTitle:
      'Silence Selection — clears the swept time range on those tracks and leaves the hole; nothing else moves. Shift+drag a lane to sweep a range.',
  },
  { label: 'Undo', commandId: 'edit.undo', Icon: Undo2, startsGroup: true, title: 'Undo (U or Ctrl+Z)' },
  { label: 'Redo', commandId: 'edit.redo', Icon: Redo2, title: 'Redo (R or Ctrl+Y)' },
];

/** M7 — one blocked tooltip, with this button's own reason inside it. The
 * words "Multitrack" and "Waveform or Spectral" stay in every one of them: the
 * refusal is only half the message, and naming the view that CAN do it is the
 * other half. */
const blockedTitle = (label: string, reason: string) =>
  `${label} — not available in the Multitrack view: ${reason}. Switch to Waveform or Spectral to edit the document.`;

// Toolbar.tsx `pillIconBtn`, verbatim: the interactive hover/press/disabled
// states come from .glass-pill-btn in index.css, which inline styles cannot
// express.
const editIconBtn: CSSProperties = {
  width: 30,
  height: 30,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  borderRadius: 9,
  border: '1px solid transparent',
  background: 'transparent',
  color: 'var(--glass-text-chrome-primary)',
  cursor: 'pointer',
};

const divider: CSSProperties = {
  width: 1,
  height: 16,
  margin: '0 4px',
  background: 'var(--glass-border)',
  flexShrink: 0,
};

export default function EditToolbar() {
  // Subscribe to the whole store so every predicate is recomputed on any state
  // change — the MenuBar's own subscription, for the same reason.
  useAppStore((s) => s);
  // R3: session undo entries write the SESSION store, not the app store, so
  // Undo/Redo enablement in the multitrack view also needs the history's
  // version counter (MenuBar carries the identical pair).
  useHistoryVersion();
  // Item 10: `edit.split`'s multitrack predicate reads the SESSION store — the
  // clips, the clip selection and the edit cursor — and every one of those
  // writers (`setMtCursor`, the selection setters) records nothing and touches
  // no appStore field. Without these three the Split button would grey and
  // un-grey one unrelated render LATE. Three narrow selectors rather than the
  // whole store on purpose: `mtPlayheadSample` ticks at pump rate during
  // playback and would repaint the pill with it.
  useSessionStore((s) => s.session);
  useSessionStore((s) => s.selectedClipIds);
  useSessionStore((s) => s.mtCursorSample);
  // D3: a double-click on empty lane space writes `selectedGap` and NOTHING
  // else, so without this the Delete/Ripple Delete predicates would light one
  // unrelated render late — the same argument as the three above.
  useSessionStore((s) => s.selectedGap);
  // Lot J: a Shift-drag sweep writes `mtTimeRange` and nothing else, so
  // without this fifth selector the Trim/Silence rows would grey and un-grey
  // one unrelated render late too.
  useSessionStore((s) => s.mtTimeRange);
  // Lot L: `pasteBlockReason` reads `currentTrackId` (K2/K3), whose three
  // writers (`ClipView`/`TrackHeader`/`TrackLane`'s own `setCurrentTrack`
  // calls) touch no appStore field either — without this sixth selector,
  // clicking a track's background would grey/un-grey Paste one unrelated
  // render late, same as the five above.
  useSessionStore((s) => s.currentTrackId);
  const documentCount = useAppStore((s) => s.documents.length);
  const isMultitrack = useAppStore((s) => s.view) === 'multitrack';

  // The in-app clipboard is a module slot with no subscribers, so a Copy from
  // THIS pill changes no store and would leave Paste grey until the next
  // unrelated state change. One local tick after the command settles closes
  // that gap for the pill's own path (the keyboard path shares the Edit
  // menu's existing latency, which this task does not change).
  const [, setTick] = useState(0);
  const run = useCallback(async (id: string) => {
    await runCommand(id);
    setTick((t) => t + 1);
  }, []);

  // "Hidden only in the empty app" — one loaded file is enough, in any view.
  if (documentCount === 0) return null;

  return (
    <ChromePill
      data-testid="edit-pill"
      className="pointer-events-auto flex items-center"
      style={{ borderRadius: 14, padding: '6px 8px', gap: 3 }}
    >
      {EDIT_TOOLBAR_ITEMS.map((item) => {
        const { label, commandId, Icon, startsGroup, multitrackReason, multitrackTitle, title } =
          item;
        // F1: enablement is the COMMAND's, with nothing added here — the view
        // gate lives in the registry so this pill, the Edit menu and the
        // keyboard cannot disagree. The two multitrack fields only choose the
        // tooltip: why this button is dark (`multitrackReason`), or what it
        // does INSTEAD in that view (`multitrackTitle`).
        const disabled = !isCommandEnabled(commandId);
        const multitrackHint = isMultitrack
          ? multitrackReason !== undefined
            ? blockedTitle(label, multitrackReason)
            : (multitrackTitle ?? title)
          : title;
        return (
          <span key={commandId} className="flex items-center">
            {startsGroup && <span aria-hidden="true" style={divider} />}
            <button
              type="button"
              aria-label={label}
              title={multitrackHint}
              disabled={disabled}
              onClick={() => void run(commandId)}
              className="glass-pill-btn"
              style={editIconBtn}
            >
              <Icon size={15} />
            </button>
          </span>
        );
      })}
    </ChromePill>
  );
}
