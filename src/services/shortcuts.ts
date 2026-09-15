import { hasOpenDialog } from './dialogBus';
import { runCommand } from './menuActions';

export interface Shortcut {
  combo: string; // normalized 'ctrl+shift+alt+key', e.g. 'ctrl+z', 'space', 'ctrl+shift+z'
  commandId: string;
}

/** Global combo -> command map. Order is not significant for lookup (a Map is
 * built from it), but is kept in a logical grouping for readability. */
// Lot H (items 8, 9) — the user's own bare-letter scheme (H5), every existing
// Ctrl combo left standing beside it (H6: additional rows, never
// replacements). Each new row sits directly after the Ctrl row it doubles, so
// the table still reads in groups. `m` (marker.add, below) is the only bare
// letter that predates this lot and it is UNCHANGED (H2) — Join takes `j`
// instead, so no collision with it ever arises. Every bare-letter row here is
// also subject to the auto-repeat guard in `installShortcuts` (H7's Risk):
// holding a Ctrl combo and releasing Ctrl a frame early makes the OS's
// key-repeat resend the bare letter, which would otherwise run a destructive
// command (e.g. `Ctrl+S` -> bare `s` -> Silence Selection) off a key the user
// never meant to press alone.
export const SHORTCUT_TABLE: Shortcut[] = [
  { combo: 'space', commandId: 'transport.playPause' },
  { combo: 'ctrl+z', commandId: 'edit.undo' },
  { combo: 'u', commandId: 'edit.undo' },
  { combo: 'ctrl+shift+z', commandId: 'edit.redo' },
  { combo: 'ctrl+y', commandId: 'edit.redo' },
  { combo: 'r', commandId: 'edit.redo' },
  // Item 8 (M1) — Split at Cursor. `ctrl+k` was free (checked against every
  // row here); the command is view-routed, so the one row serves every view.
  { combo: 'ctrl+k', commandId: 'edit.split' },
  // H3/H5 — `c` is the scissors (Split at Cursor). Cut keeps `Ctrl+X` only —
  // no bare letter, no new button (H3, the user's own ruling).
  { combo: 'c', commandId: 'edit.split' },
  // H1/H2 — Join Clips (renamed from Merge Clips). `m` stays Add Marker, so
  // Join takes `j` instead of colliding with it.
  { combo: 'j', commandId: 'multitrack.joinClips' },
  { combo: 'ctrl+x', commandId: 'edit.cut' },
  { combo: 'ctrl+c', commandId: 'edit.copy' },
  { combo: 'ctrl+v', commandId: 'edit.paste' },
  { combo: 'delete', commandId: 'edit.delete' },
  { combo: 'd', commandId: 'edit.delete' },
  // K1 — Ripple Delete. `Shift+Delete` was free in this table (checked against
  // every row above and below), and it is the combo the verb carries in the
  // NLEs this feature was asked to match. Item 7 gave the command an editor
  // branch (remove the selection and close the gap — the pre-item-7 Delete),
  // so the one row now serves every view; `runCommand` re-checks `enabled`
  // before running, which is what keeps a global table from needing a
  // per-view table beside it.
  { combo: 'shift+delete', commandId: 'edit.rippleDelete' },
  { combo: 'ctrl+a', commandId: 'edit.selectAll' },
  // H4/H8 — Select All, new on the pill. One view-routed command (H8): the
  // whole file in the editors, every clip on every track in Multitrack.
  { combo: 'a', commandId: 'edit.selectAll' },
  { combo: 't', commandId: 'edit.trim' },
  { combo: 's', commandId: 'edit.silence' },
  // K1 — clip-edge navigation. `e.key` for the arrows is 'ArrowLeft'/
  // 'ArrowRight', so the normalized combos carry the 'arrow' prefix; the menu
  // rows advertise them as the Ctrl+Left / Ctrl+Right a user would write.
  //
  // Nothing else in this app binds an arrow, and the evidence is stronger than
  // the sentence that used to stand here: a repo-wide search for
  // `ArrowLeft|ArrowRight` outside tests finds these two rows and a
  // `lucide-react` ICON import in `ConvertDialog` (`ArrowLeftRight`, drawn on a
  // button) — there is no arrow-key handler anywhere in `src/`. The earlier
  // wording cited ConvertDialog's "form controls" as the one arrow reader,
  // which described a handler that does not exist; a phantom to defer to is a
  // worse note to leave behind than the real absence, because the next editor
  // goes looking for it.
  { combo: 'ctrl+arrowleft', commandId: 'multitrack.prevClipEdge' },
  { combo: 'ctrl+arrowright', commandId: 'multitrack.nextClipEdge' },
  { combo: 'home', commandId: 'transport.goToStart' },
  { combo: 'end', commandId: 'transport.goToEnd' },
  { combo: 'ctrl+o', commandId: 'file.open' },
  { combo: 'ctrl+s', commandId: 'file.save' },
  { combo: 'ctrl+n', commandId: 'file.new' },
  // T4 — the third of the same drift, and the one the Ctrl+W fix left behind.
  // `file.saveAs` has advertised `Ctrl+Shift+S` on its File menu row since the
  // row existed, with no combo here: the label named a key that did nothing.
  // It routes to the same `saveDocument(id, true)` the row runs, so the
  // accelerator does exactly what clicking the row does — including the save
  // dialog, so it can never overwrite anything without being asked.
  //
  // `ctrl+shift+s` was free: checked against every row above and below, and
  // `comboFromEvent` emits modifiers in a fixed `ctrl+shift+alt` order, so
  // there is one spelling of it and this is it. The sweep in shortcuts.test.ts
  // now checks the whole class rather than this one key.
  { combo: 'ctrl+shift+s', commandId: 'file.saveAs' },
  // The File menu has advertised `Ctrl+W` on its Close row since Task 11, but
  // this table never carried the combo, so the label named a key that did
  // nothing. It routes to `file.close`, the same `closeDocumentFlow` the
  // Files-panel ✕ uses (B3 — the two doors cannot diverge because they are
  // one function), so it prompts for unsaved EDITS exactly as the ✕ does
  // (lot B) — a never-saved computed document closes with no prompt either
  // way.
  { combo: 'ctrl+w', commandId: 'file.close' },
  { combo: 'm', commandId: 'marker.add' },
  { combo: 'ctrl+e', commandId: 'file.export' },
  { combo: 'escape', commandId: 'edit.deselect' },
];

const STANDALONE_MODIFIER_KEYS = new Set(['control', 'shift', 'alt', 'meta']);

/** Normalizes a keydown event into a combo string: modifiers in a fixed
 * 'ctrl+shift+alt' order, followed by the lowercased key. The space bar maps
 * to the literal 'space'. Standalone modifier keydowns (pressing just
 * Ctrl/Shift/Alt/Meta) normalize to '' since they never form a usable combo.
 *
 * H7 (lot H): a Meta-held keydown normalizes to '' too, rather than being
 * built from `ctrlKey`/`shiftKey`/`altKey` and silently dropping Meta from
 * the combo. Meta was never part of the documented table, so before this a
 * `Meta+D` keydown normalized to the bare `d` and FIRED `edit.delete` —
 * a modifier the table does not model running a destructive command a
 * `Ctrl+D` or `Alt+D` keydown correctly does nothing for (both normalize to
 * combos no row binds). No row in SHORTCUT_TABLE uses Meta, so nothing is
 * lost by rejecting it outright. */
export function comboFromEvent(e: KeyboardEvent): string {
  const key = e.key.toLowerCase();
  if (STANDALONE_MODIFIER_KEYS.has(key)) return '';
  if (e.metaKey) return '';

  const parts: string[] = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  parts.push(key === ' ' ? 'space' : key);
  return parts.join('+');
}

/** True when the event target is a form control or contenteditable element
 * that should receive normal typed input instead of triggering a shortcut.
 *
 * H7 (lot H): verified sufficient for the bare destructive letters this lot
 * added (`d`, `t`, `s`, …). The `INPUT` check is type-blind, so it already
 * covers every slider in the app (every one is `<input type="range">`),
 * arrow-key nudges included — a focused slider inside an open effect card or
 * the Pipeline card is an INPUT and is already gated. A focused plain
 * `<button>` is deliberately NOT gated: the pill's own buttons are buttons,
 * so focus sits on one immediately after every click, and gating it would
 * make a bare letter silently stop working right after the toolbar was used
 * — the worse defect. `EffectHost.tsx`'s `isEditableTargetOutsideTheCard`
 * duplicates this same tag list for its own (deliberately card-scoped)
 * Escape gate — a tag added here later must move there too. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

/** H7 (lot H) — the auto-repeat hazard: hold `Ctrl`, press and hold a bound
 * letter (e.g. `S`), release `Ctrl` a frame early while the key is still
 * down. The OS's key-repeat then resends keydowns for the letter alone —
 * `ctrlKey: false` — which normalize to the BARE combo and would otherwise
 * run it (`Ctrl+S` released early -> repeat `s` -> Silence Selection, a
 * destructive edit the user never chose to run bare). Matches a single
 * lowercase letter with no modifier prefix — exactly the shape of every new
 * bare-letter row this lot added (`u r c j d a t s`, and the pre-existing
 * `m`). Not special-cased to the destructive ones (H6 treats letters as
 * ordinary rows, and H7 rejected singling out `d` for the editable-target
 * gate on the same principle) — a repeat keydown is dropped for the whole
 * class. */
const BARE_LETTER_COMBO = /^[a-z]$/;

const COMBO_TO_COMMAND: Map<string, string> = new Map(
  SHORTCUT_TABLE.map((s) => [s.combo, s.commandId])
);

/** Installs a single keydown listener on `target` that maps SHORTCUT_TABLE
 * combos to `runCommand`. Skips input/textarea/select/contentEditable focus
 * targets and IME composition so typing is never hijacked, and bails entirely
 * while any dialog is open (F10) — with a dialog open, focus commonly sits on
 * body or a plain BUTTON, so without this gate ctrl+n/ctrl+o/ctrl+e/ctrl+s/m/
 * space/delete would still fire behind it; several dialogs resolve their
 * target document from the live activeDocumentId at confirm time, so e.g.
 * Ctrl+O while Export is open would make Export write the wrong document.
 * Returns an uninstaller that removes the listener. */
export function installShortcuts(target: Window): () => void {
  const handleKeydown = (e: KeyboardEvent): void => {
    if (e.isComposing) return;
    if (hasOpenDialog()) return;
    if (isEditableTarget(e.target)) return;

    const combo = comboFromEvent(e);
    if (!combo) return;
    // H7 — drop an auto-repeat keydown for a bare letter (see
    // BARE_LETTER_COMBO's docblock): the mechanism that produces one is a
    // modifier released a frame early while the key itself is still held, not
    // a deliberate second press.
    if (e.repeat && BARE_LETTER_COMBO.test(combo)) return;

    const commandId = COMBO_TO_COMMAND.get(combo);
    if (!commandId) return;

    // A MATCHED combo is claimed here, before `runCommand` consults the
    // command's own `enabled` predicate — so a row whose command is disabled in
    // the current view still swallows the platform default. K1's
    // `ctrl+arrowleft`/`ctrl+arrowright` are multitrack-only commands, so that
    // is observable in the waveform and spectral views (`shift+delete` has an
    // editor branch since item 7, but is still claimed with no selection).
    //
    // Kept deliberately rather than gated on `isCommandEnabled`, and recorded
    // here so it is not rediscovered as a defect: enablement-gating would hand
    // Chromium's own defaults back exactly where this table means to own the
    // key — Ctrl+S "save page as", Ctrl+O "open file", space-scroll — in every
    // view where the app happens to have nothing to do with it. The cost is
    // bounded by `isEditableTarget` above, which has already returned for
    // INPUT/TEXTAREA/SELECT/contentEditable, so word-jump and Delete still
    // behave normally in the only places a user types.
    e.preventDefault();
    void runCommand(commandId);
  };

  target.addEventListener('keydown', handleKeydown);
  return () => target.removeEventListener('keydown', handleKeydown);
}
