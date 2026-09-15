import { useCallback, useEffect, useRef } from 'react';
import { getEffect } from '../../effects/EffectRegistry';
import { hasOpenDialog } from '../../services/dialogBus';
import { MODULE_COLUMN_WIDTH } from '../Layout/ModuleStrip';
import { GlassCard } from '../UI/glass';
import { DialogHostProvider } from './DialogHost';
import EffectDialog from './EffectDialog';

/**
 * Item 6 (2026-08-18) / M6 — the card that hosts ONE effect in the module
 * column, between the module strip (and the TempoCard) and the module card.
 *
 * The user's ruling: "all effects open with a single click and, instead of a
 * modal, open between the module bar and the extended modules." The seam
 * already existed — `DialogShell` renders as in-flow card chrome whenever a
 * `DialogHostProvider` sits above it (U2-3), which is how the nine pipeline
 * tools left their modals without a line of their own changing. This is the
 * same seam with the same provider, and `EffectDialog` is unchanged in body.
 *
 * What differs from `PipelineToolHost`, and why. That host is 640 wide and
 * pulls itself LEFT out of the 348 column with a negative margin, because a
 * pipeline stepper needs the room; the strip follows it to 640 (W1). An
 * effect's body fits the column, so this card is exactly `MODULE_COLUMN_WIDTH`
 * with no margin — the strip stays 348 and W1 holds in every state without the
 * strip learning a third width. No `max-height` either: the column's bounded
 * height (`top 68` / `bottom 58`) is the only cap, shared with the module card
 * beneath through the default `flex: 0 1 auto` shrink, and the hosted shell's
 * body scrolls inside the card.
 *
 * The card is independent of the module card below it: App forces that card to
 * Effects when an effect opens (N16), and afterwards the strip may swap or
 * close it while the effect stays. Lot C fix round 1 (C5): opening a pipeline
 * tool (`openTool`) no longer closes this card either — the two are
 * independent retained slots now, and a tool foregrounding over it only
 * backgrounds it (`backgrounded`, below). Only the ✕ / Cancel / Apply /
 * `Escape`, and the orphan rule (no document left), actually close this one.
 *
 * `Escape` (N18, 2026-08-23). While the card is mounted and idle, `Escape`
 * closes it — exactly what the key did when the effect was a modal — through
 * `onClose`, the ✕'s own path, so the dialog's unmount-restore hands the engine
 * the real document back if a Preview was running. It is claimed here, on the
 * document, BEFORE it can reach the window listener `installShortcuts` sits on
 * (`shortcuts.ts` maps `escape` to `edit.deselect`): the selection survives,
 * so the next Apply still writes the span the user auditioned. While Apply
 * runs the key does nothing (the ✕ refuses then; `hasOpenDialog()` is true
 * and the global table is suspended anyway). With a modal stacked over the
 * card (`hasOpenDialog()` from the stack), the key is the modal's. A key typed
 * in a field OUTSIDE the card stays that field's — a marker rename's own
 * `Escape` — as every global key does; inside the card it closes it, as the
 * modal's did. `DialogShell`'s hosted branch still installs nothing: the nine
 * pipeline tools keep their "Escape does nothing" rule, and this one is the
 * effect card's alone.
 *
 * One effect id, one dialog instance. `PipelineToolHost` swaps the component
 * TYPE per command id, so React remounts on a swap for free; this host renders
 * the same `EffectDialog` for every id, and React would keep the mounted
 * instance — with the previous effect's `params`, `previewing` and `busy`
 * state — under the new name (every control of the new effect NaN, Apply
 * sending values the card never showed, a preview of the first effect still
 * playing under the second's name). The key on the dialog is what makes a
 * click on a second row a fresh card: the old dialog unmounts (its
 * unmount-restore hands the engine the real document back) and the new one
 * starts from its own declared defaults.
 */
export default function EffectHost({
  effectId,
  backgrounded = false,
  onClose,
  onModuleLockChange,
}: {
  /** A registry effect id; nothing renders for an id the registry does not know. */
  effectId: string;
  /** C1/C2/C-e (lot C, item 3) — `true` while this card is RETAINED but not
   * the foregrounded surface (the user left the Effects module for another
   * one). The card stays mounted — `App` never nulls `hostedEffect` on a
   * module switch any more — and this prop is the only thing that changes: it
   * drives `data-backgrounded`/`hidden`/`display:none` below (C-e) and makes
   * the Escape listener inert (C-g), so a background card cannot be closed by
   * a key the user cannot see the effect of. */
  backgrounded?: boolean;
  onClose(): void;
  /** Raised with the effect's module LOCK — `true` while Apply is running
   * (N16: Apply only; Preview locks nothing). App turns that into a greyed
   * module strip and a live `hasOpenDialog()`, released by the shell's own
   * cleanup on unmount. */
  onModuleLockChange(locked: boolean): void;
}) {
  // The lock as the shell last published it — `true` while Apply runs. A ref,
  // because the Escape listener below is installed once and must read the
  // CURRENT value, not the one it closed over.
  const lockedRef = useRef(false);
  // C-g: mirrors `backgrounded` for the same reason — the Escape listener is
  // installed once (`[known]`) and must read the CURRENT value.
  const backgroundedRef = useRef(false);
  backgroundedRef.current = backgrounded;
  // Stable identity, so the provider's memo does not re-publish per paint.
  const report = useCallback(
    (locked: boolean) => {
      lockedRef.current = locked;
      onModuleLockChange(locked);
    },
    [onModuleLockChange]
  );
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const known = getEffect(effectId) !== undefined;

  // N18 — see the docblock. On `document` in the bubble phase so the target's
  // own handlers and the other document listeners (a modal's, the menu bar's)
  // still run, and `stopPropagation` stops exactly one thing: the window
  // listener that would have run `edit.deselect`.
  useEffect(() => {
    if (!known) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // C-g: a backgrounded card is not on screen — closing it would discard
      // a card the user cannot see, and stealing Escape from the stage's own
      // `edit.deselect` for a key that has no visible effect is worse than
      // doing nothing. Read through the ref: this listener is installed once.
      if (backgroundedRef.current) return;
      if (lockedRef.current || hasOpenDialog()) return;
      if (isEditableTargetOutsideTheCard(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [known]);

  if (!known) return null;

  return (
    <GlassCard
      data-testid="effect-host"
      data-effect-id={effectId}
      // C-e: hidden means `display:none` on the card's OWN GlassCard, plus the
      // `hidden` attribute and `data-backgrounded` for satellites/tests to key
      // on. `GlassCard`'s className carries Tailwind `flex` (below), which
      // beats the UA `[hidden]{display:none}` rule — only the inline style
      // wins, so it is set explicitly rather than relying on the attribute.
      data-backgrounded={backgrounded ? 'true' : undefined}
      hidden={backgrounded}
      className="pointer-events-auto flex min-h-0 flex-col"
      style={{
        flex: '0 1 auto',
        overflow: 'hidden',
        width: MODULE_COLUMN_WIDTH,
        display: backgrounded ? 'none' : undefined,
      }}
    >
      <DialogHostProvider onModuleLockChange={report}>
        <EffectDialog key={effectId} effectId={effectId} backgrounded={backgrounded} onClose={onClose} />
      </DialogHostProvider>
    </GlassCard>
  );
}

/** A form control or contentEditable being typed in, somewhere other than in
 * this card — `shortcuts.ts`'s own editable-target rule, narrowed to outside
 * the card so a parameter field inside it still closes the card on Escape, as
 * the modal did. */
function isEditableTargetOutsideTheCard(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  const editable =
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  if (!editable) return false;
  return target.closest('[data-testid="effect-host"]') === null;
}
