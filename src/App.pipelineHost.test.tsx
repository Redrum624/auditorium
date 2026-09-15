import { act, fireEvent, render, screen, within } from '@testing-library/react';
import App from './App';
import DialogShell from './components/Dialogs/DialogShell';
import { TOOL_HOST_WIDTH, hostedToolIds } from './components/Dialogs/PipelineToolHost';
import { MODULE_COLUMN_WIDTH } from './components/Layout/ModuleStrip';
import { createDocument } from './audio/AudioDocument';
import { hasOpenDialog } from './services/dialogBus';
import { isCommandEnabled, runCommand } from './services/menuActions';
import { _resetPassLock, acquirePass, getRunningPass, isPassRunning } from './services/passLock';
import { makeInitialState, useAppStore } from './stores/appStore';

/**
 * U2-3 — pipelines open IN the module column, from every door, with the stage
 * left alive.
 *
 * `TempoDialog` is stubbed here, and only it: the mid-run half of this file
 * needs a hosted tool whose `dismissable` a test can drive, and `dismissable`
 * is a dialog's INTERNAL busy flag that no test may reach from outside. The
 * stub renders the real `DialogShell` — the seam under test — so what is faked
 * is the pass, not the mounting. The other eight are the real components.
 */
jest.mock('./components/Dialogs/TempoDialog', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const Shell = jest.requireActual<{ default: typeof DialogShell }>(
    './components/Dialogs/DialogShell'
  ).default;
  return {
    __esModule: true,
    default: function StubTempoDialog({ onClose }: { onClose: () => void }) {
      const [busy, setBusy] = React.useState(false);
      return React.createElement(Shell, {
        title: 'Match Tempo',
        dismissable: !busy,
        onClose,
        children: [
          // Lot C (item 3): a field with its own local `useState`, so a
          // module-switch round trip through the host has something to prove
          // survives — exactly the shape of an arbitrary effect card's own
          // params, which C2 says cannot be enumerated and so must not be
          // destroyed by unmounting.
          React.createElement('input', {
            key: 'field',
            type: 'text',
            'data-testid': 'tempo-key-field',
            defaultValue: '',
          }),
          React.createElement(
            'button',
            { key: 'toggle', type: 'button', onClick: () => setBusy((b) => !b) },
            busy ? 'finish pass' : 'start pass'
          ),
          // The hand-off shape RemixDialog and TranscribeDialog really have:
          // the pass ends and the panel is opened in the SAME synchronous
          // block, so React has not re-rendered and `busy` is still true at
          // the moment the panel is asked for. Reproduced exactly, because it
          // is the case a naive "refuse while running" guard breaks.
          React.createElement(
            'button',
            {
              key: 'handover',
              type: 'button',
              onClick: () => {
                setBusy(false);
                jest
                  .requireActual<typeof import('./services/dialogBus')>('./services/dialogBus')
                  .focusTranscriptPanel();
                onClose();
              },
            },
            'finish and hand over'
          ),
        ],
      });
    },
  };
});

interface MessageBoxOptions {
  type?: string;
  title?: string;
  message: string;
}
const showMessageBox = jest.fn(async (_opts: MessageBoxOptions) => ({ response: 0 }));

beforeEach(() => {
  useAppStore.setState(makeInitialState());
  // Module state outlives a render: a test that ends mid-pass would otherwise
  // hand the next one an `isPassRunning()` that is true with nothing running.
  _resetPassLock();
  showMessageBox.mockClear();
  // `showMessageBox` is the channel the mid-run refusal speaks through (the
  // same one every other refusal in the app uses). The two subscriptions are
  // what App and TitleBar reach for on mount: a preload object that exists but
  // lacks them throws, where no preload at all short-circuits.
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    showMessageBox,
    onWindowMaximized: () => () => {},
    onCloseRequested: () => () => {},
    respondCloseRequest: () => {},
  };
});

function addDoc() {
  const doc = createDocument({
    name: 'take.wav',
    sampleRate: 44100,
    channels: [new Float32Array(44100)],
  });
  act(() => {
    useAppStore.getState().addDocument(doc);
  });
  return doc;
}

function strip(): HTMLElement {
  return screen.getByTestId('sidebar-tabs');
}

function stripButton(label: string): HTMLButtonElement {
  return within(strip()).getByRole('button', { name: label }) as HTMLButtonElement;
}

async function openTool(id: string) {
  await act(async () => {
    await runCommand(id);
  });
}

describe('a pipeline tool opens in the module column, not over the stage', () => {
  /**
   * Derived over the host's own registry rather than a list typed here: a tool
   * added to the host must arrive already hosted, and a test that named nine
   * ids would go on passing while a tenth quietly opened a modal.
   *
   * The explicit timeout is the price of that derivation: this is a full `App`
   * render PER HOSTED ID, so its cost grows with the roster — D4's tenth id
   * (`voice.separate`) took it close enough to jest's 5 s default that a loaded
   * machine tipped it over in a full-suite run while passing in isolation. The
   * sweep is worth keeping and the roster will only grow, so the budget is
   * stated rather than inherited (the `dsp/remix*` suites' convention).
   */
  it('routes every hosted tool into the column, with no backdrop anywhere', async () => {
    for (const id of hostedToolIds()) {
      addDoc();
      const view = render(<App />);
      await openTool(id);
      expect(screen.getByTestId('tool-host')).toHaveAttribute('data-tool-id', id);
      expect(screen.queryByTestId('dialog-overlay')).toBeNull();
      // …and the module card it replaced is gone, not stacked behind it.
      expect(screen.queryByTestId('sidebar-panel')).toBeNull();
      view.unmount();
      useAppStore.setState(makeInitialState());
    }
  }, 30000);

  it('shows Pipeline as the active module while a tool is hosted', async () => {
    addDoc();
    render(<App />);
    await openTool('effects.coverChain');
    expect(stripButton('Pipeline')).toHaveAttribute('aria-pressed', 'true');
    expect(stripButton('Pipeline')).toHaveClass('is-active');
  });

  it('gives the stage the host’s clearance, and hands it back on close', async () => {
    addDoc();
    render(<App />);
    const stage = screen.getByTestId('editor-stage');
    // A plain module card: 14 + 348 + 14.
    expect(stage.style.getPropertyValue('--stage-inset-right')).toBe('376px');

    await openTool('tempo.match');
    // The host: 14 + 640 + 14.
    expect(stage.style.getPropertyValue('--stage-inset-right')).toBe('668px');

    fireEvent.click(screen.getByTestId('hosted-tool-close'));
    expect(stage.style.getPropertyValue('--stage-inset-right')).toBe('376px');
  });

  /**
   * W1: the user's rule — "the module bar and the extended modules must always
   * have the same width." The strip renders at the SAME constant the host
   * renders at, so the two cannot drift apart: 348 with a module card open,
   * 640 while a tool is hosted, and back the moment it closes.
   */
  it('keeps the strip exactly as wide as the surface below it — card or host', async () => {
    addDoc();
    render(<App />);
    expect(strip().style.width).toBe(`${MODULE_COLUMN_WIDTH}px`);

    await openTool('tempo.match');
    expect(strip().style.width).toBe(`${TOOL_HOST_WIDTH}px`);
    expect(screen.getByTestId('tool-host').style.width).toBe(`${TOOL_HOST_WIDTH}px`);

    fireEvent.click(screen.getByTestId('hosted-tool-close'));
    expect(strip().style.width).toBe(`${MODULE_COLUMN_WIDTH}px`);
  });

  it('returns to the Pipeline card when the tool closes', async () => {
    addDoc();
    render(<App />);
    await openTool('tempo.match');
    fireEvent.click(screen.getByTestId('hosted-tool-close'));
    expect(screen.queryByTestId('tool-host')).toBeNull();
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'pipeline');
    expect(screen.getByTestId('pipeline-panel')).toBeInTheDocument();
  });

  it('leaves the global shortcuts live while a tool is open but idle', async () => {
    addDoc();
    render(<App />);
    await openTool('tempo.match');
    // The stage is the point: a hosted tool must not take Space, Ctrl+O or the
    // arrows away from the editor the way an open modal does.
    expect(hasOpenDialog()).toBe(false);
    // Idle: nothing has acquired the pass lock either.
    expect(isPassRunning()).toBe(false);
  });
});

/**
 * C1/C2 (lot C, item 3) — the tool card is now kept MOUNTED across a module
 * switch, hidden rather than destroyed: `App.tsx` no longer calls
 * `setHostedTool(null)` from `selectModule`. Before this lot, switching to
 * Markers here unmounted the host and the field's text was gone; this test
 * fails against that code (revert-and-watch-it-fail evidence in the report).
 */
describe('the tool card backgrounds with its module and comes back in the state it was left (C1/C2)', () => {
  it('keeps the same host mounted, hidden, across a module switch, and foregrounds it again', async () => {
    addDoc();
    render(<App />);
    await openTool('tempo.match');
    const field = screen.getByTestId('tempo-key-field') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'Bb minor' } });
    expect(field.value).toBe('Bb minor');

    fireEvent.click(stripButton('Markers'));

    const node = screen.getByTestId('tool-host');
    expect(node).toHaveAttribute('data-tool-id', 'tempo.match');
    expect(node).toHaveAttribute('data-backgrounded', 'true');
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'markers');
    expect(strip().style.width).toBe(`${MODULE_COLUMN_WIDTH}px`);

    fireEvent.click(stripButton('Pipeline'));

    // The SAME DOM node returns — nothing was ever unmounted (C2).
    expect(screen.getByTestId('tool-host')).toBe(node);
    expect(screen.getByTestId('tool-host')).not.toHaveAttribute('data-backgrounded');
    expect((screen.getByTestId('tempo-key-field') as HTMLInputElement).value).toBe('Bb minor');
    expect(strip().style.width).toBe(`${TOOL_HOST_WIDTH}px`);
  });
});

/**
 * C-d — a click on the module the host is already foregrounded on reveals
 * that module's own chooser panel first (backgrounding the host); a second
 * such click, with nothing left to background, closes the card as before.
 */
describe('a click on the active module reveals the chooser before closing the card (C-d)', () => {
  it('backgrounds the host on the first click, then closes the card on the second', async () => {
    addDoc();
    render(<App />);
    await openTool('tempo.match');
    expect(strip().style.width).toBe(`${TOOL_HOST_WIDTH}px`);

    fireEvent.click(stripButton('Pipeline'));
    expect(screen.getByTestId('tool-host')).toHaveAttribute('data-backgrounded', 'true');
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'pipeline');
    expect(screen.getByTestId('pipeline-panel')).toBeInTheDocument();
    expect(strip().style.width).toBe(`${MODULE_COLUMN_WIDTH}px`);

    fireEvent.click(stripButton('Pipeline'));
    expect(screen.queryByTestId('sidebar-panel')).toBeNull();
    // The host is still mounted, still backgrounded — this second click closed
    // the CARD, not the retained tool.
    expect(screen.getByTestId('tool-host')).toHaveAttribute('data-backgrounded', 'true');
  });
});

/**
 * C-i — the orphan rule (previously effect-only) extended to the tool slot:
 * dropping the last document must not leave a retained, backgrounded tool
 * card behind either.
 */
describe('the orphan rule drops a backgrounded tool too (C-i)', () => {
  it('closes the retained tool card when the last document closes', async () => {
    const doc = addDoc();
    render(<App />);
    await openTool('tempo.match');
    fireEvent.click(stripButton('Markers'));
    expect(screen.getByTestId('tool-host')).toHaveAttribute('data-backgrounded', 'true');

    act(() => {
      useAppStore.getState().closeDocument(doc.id);
    });

    expect(screen.queryByTestId('tool-host')).toBeNull();
  });
});

/**
 * C4, the idle case: mirrors the equivalent effect-side test in
 * `App.effectHost.test.tsx`. `running` reads lot M's lock, not a parallel
 * flag — proven here by its absence: idle, nothing holds the lock.
 */
describe('the strip badge reads the lock, not a parallel flag (C4)', () => {
  it('shows an idle badge naming the backgrounded tool', async () => {
    addDoc();
    render(<App />);
    await openTool('tempo.match');
    expect(screen.queryByTestId('module-badge-pipeline')).toBeNull();

    fireEvent.click(stripButton('Markers'));

    expect(isPassRunning()).toBe(false);
    const badge = screen.getByTestId('module-badge-pipeline');
    expect(badge).toHaveAttribute('data-running', 'false');
    expect(stripButton('Pipeline').title).toContain('Match Tempo');
  });

  /**
   * Fix round 1 (C3/C4) — the badge's `running` state, now reachable: a
   * pass backgrounded WHILE it runs (C3) shows the running dot, and the dot
   * clears the instant the pass ends, even though the tool stays retained
   * (still backgrounded, still showing an idle badge afterward). `running`
   * reads `usePassLock()` directly, compared by descriptor id — proven by
   * this test needing NO separate "is it running" flag anywhere in `App.tsx`.
   */
  it('shows a RUNNING badge while a backgrounded pass runs, and clears it the instant the pass ends', async () => {
    addDoc();
    render(<App />);
    await openTool('tempo.match');
    fireEvent.click(screen.getByRole('button', { name: 'start pass' }));
    fireEvent.click(stripButton('Markers'));

    expect(isPassRunning()).toBe(true);
    const badge = screen.getByTestId('module-badge-pipeline');
    expect(badge).toHaveAttribute('data-running', 'true');
    expect(stripButton('Pipeline').title).toBe(
      'Match Tempo is running in the background — click to watch it'
    );

    // Watch it: foreground it again, the stub still reads 'finish pass'.
    fireEvent.click(stripButton('Pipeline'));
    expect(screen.getByRole('button', { name: 'finish pass' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'finish pass' }));
    expect(isPassRunning()).toBe(false);

    fireEvent.click(stripButton('Markers'));
    // Still retained, still backgrounded — the badge stays, but idle now.
    expect(screen.getByTestId('module-badge-pipeline')).toHaveAttribute('data-running', 'false');
  });
});

describe('every door reaches the same host', () => {
  it('the Pipeline card’s row', async () => {
    addDoc();
    render(<App />);
    fireEvent.click(stripButton('Pipeline'));
    const row = screen
      .getAllByTestId('pipeline-item')
      .find((r) => r.getAttribute('data-command-id') === 'edit.voiceChanger')!;
    await act(async () => {
      fireEvent.click(within(row).getByRole('button'));
    });
    expect(screen.getByTestId('tool-host')).toHaveAttribute('data-tool-id', 'edit.voiceChanger');
  });

  // Item 5 (2026-08-18): the Effects card's Pipeline rows were a second door
  // (F11-6, kept at U2); the user rules one — a Pipeline tool lives in the
  // Pipeline module only. What the card keeps is the Effects MENU's own Mix
  // row (N15), which is not a Pipeline tool and has no strip icon of its own.
  it('the Effects card carries no Pipeline door — only the Mix row', async () => {
    addDoc();
    render(<App />);
    fireEvent.click(stripButton('Effects'));
    expect(
      screen.getAllByTestId('effects-tool-item').map((r) => r.getAttribute('data-command-id'))
    ).toEqual(['spatial.position']);
    expect(screen.queryByTestId('tool-host')).toBeNull();
  });

  // The menu's door is `runCommand(id)` — the same call MenuBar makes on a
  // click (MenuBar.test pins that it does), so this is that door end to end
  // from the command down.
  it('the Pipeline menu’s command', async () => {
    addDoc();
    render(<App />);
    await openTool('lyrics.align');
    expect(screen.getByTestId('tool-host')).toHaveAttribute('data-tool-id', 'lyrics.align');
  });
});

/**
 * The mid-run decision, and the evidence behind it.
 *
 * Every one of the nine keeps its pass in component state and cancels it on
 * unmount (`cancelledRef` / `unmountedRef`, each run body returning early after
 * its await). So switching module mid-pass would not background the run — it
 * would DISCARD it. Blocking is therefore the honest answer, and it is enforced
 * with the flag the dialogs already publish for exactly this purpose:
 * `dismissable={!busy}`, which has always refused Escape and a backdrop click.
 */
describe('while a hosted pass is running', () => {
  async function startPass() {
    addDoc();
    render(<App />);
    await openTool('tempo.match');
    fireEvent.click(screen.getByRole('button', { name: 'start pass' }));
  }

  // Fix round 1 (C3/M2) — OVERTURNS this test's old premise, pinned here
  // before lot C's fix round: the strip locked every button while a pass
  // ran, because leaving used to UNMOUNT the tool (discarding it). M2
  // (decisions.md, USER): "switching views and modules while a pass runs
  // stays allowed — that is the whole point of lot C. Only starting another
  // pass is refused." The invariant this test protected — a running pass is
  // never silently discarded by a module switch — still holds; it is proven
  // here the other way: the switch is now ALLOWED, and the pass keeps
  // running, backgrounded, exactly the "state it has progressed" half of
  // item 3. FAILS TODAY (pre-fix-round-1): the strip disables every button
  // mid-pass.
  it('backgrounds a running pass on a module switch instead of blocking it (C3/M2)', async () => {
    await startPass();
    fireEvent.click(stripButton('Markers'));

    expect(showMessageBox).not.toHaveBeenCalled();
    for (const button of within(strip()).getAllByRole('button')) {
      expect(button).not.toBeDisabled();
    }
    const node = screen.getByTestId('tool-host');
    expect(node).toHaveAttribute('data-backgrounded', 'true');
    expect(getRunningPass()?.label).toBe('Match Tempo');
    expect(isPassRunning()).toBe(true);

    fireEvent.click(stripButton('Pipeline'));
    // The SAME instance, still running — nothing was discarded.
    expect(screen.getByTestId('tool-host')).toBe(node);
    expect(screen.getByTestId('tool-host')).not.toHaveAttribute('data-backgrounded');
    expect(screen.getByRole('button', { name: 'finish pass' })).toBeInTheDocument();
  });

  it('refuses the tool’s own ✕, saying why', async () => {
    await startPass();
    const close = screen.getByTestId('hosted-tool-close') as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    expect(close.title).toBe('This pass is running — it cannot be closed yet');
    fireEvent.click(close);
    expect(screen.getByTestId('tool-host')).toBeInTheDocument();
  });

  // Lot M: `effects.coverChain`'s own `enabled` now ANDs in `passFree()`
  // (menuActions.ts), so `runCommand` bails before it ever calls
  // `openCoverChainDialog` — the App-level `refuseWhileRunning` message box
  // this test used to assert is therefore never reached FOR A DOOR THE
  // REGISTRY GATES. The refusal moved from an ad-hoc dialog to the uniform
  // disabled-command-with-reason surface M3 asks for; `showMessageBox` stays
  // as defence in depth for the one caller that still bypasses the registry
  // (`TranscriptPanel.tsx`'s "Transcribe again…" button — see the
  // App.effectHost.test.tsx suite for that door specifically) and for
  // `spatial.position`, which `showPanel`'s own `guard-while-running` arm
  // still refuses directly (see the test below this one).
  it('refuses to swap in another tool via the registry gate — the row was already disabled, no message box', async () => {
    await startPass();
    // Fix round 1 (MED) — restores the coverage the old
    // `showMessageBox.mock.calls[0][0].message).toContain('Match Tempo')`
    // assertion carried: `describeHostedPass()`'s label, now read straight
    // off the lock rather than off a message box nobody shows any more.
    expect(getRunningPass()?.label).toBe('Match Tempo');
    expect(isCommandEnabled('effects.coverChain')).toBe(false);

    await openTool('effects.coverChain');

    expect(screen.getByTestId('tool-host')).toHaveAttribute('data-tool-id', 'tempo.match');
    expect(showMessageBox).not.toHaveBeenCalled();
  });

  // M6 overturns the old F10 guard (App.tsx:215-233 before this lot; see that
  // file's own updated docblock) — the keyboard is no longer suspended behind
  // a BACKGROUNDED pass. `hasOpenDialog()` narrows to the modal stack, which a
  // hosted tool never joins whether idle or running; `isPassRunning()` is the
  // question that actually answers "is a pass running".
  it('does not suspend the modal-dialog stack while a pass runs — only isPassRunning() answers that (M6)', async () => {
    await startPass();
    expect(hasOpenDialog()).toBe(false);
    expect(isPassRunning()).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'finish pass' }));
    expect(hasOpenDialog()).toBe(false);
    expect(isPassRunning()).toBe(false);
    expect(stripButton('Markers')).not.toBeDisabled();
  });

  it('unlocks everything once the pass finishes', async () => {
    await startPass();
    fireEvent.click(screen.getByRole('button', { name: 'finish pass' }));
    for (const button of within(strip()).getAllByRole('button')) {
      expect(button).not.toBeDisabled();
    }
    expect((screen.getByTestId('hosted-tool-close') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(stripButton('Markers'));
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'markers');
  });

  /**
   * The hand-off, and why it is NOT refused.
   *
   * RemixDialog ends with `onClose(); focusRemixPanel();` and TranscribeDialog
   * with `focusTranscriptPanel(); onClose();` — in both, the pass finishes and
   * the panel is asked for in one synchronous block, so React has not
   * re-rendered and "a pass is running" still reads true at that instant. A
   * guard that refused every panel request while running would therefore fire
   * on the completion path of the two tools that have one, every single time,
   * and strand the user in a tool with nothing left to say.
   */
  it('lets a finishing tool hand over to its result panel', async () => {
    await startPass();
    fireEvent.click(screen.getByRole('button', { name: 'finish and hand over' }));

    expect(showMessageBox).not.toHaveBeenCalled();
    expect(screen.queryByTestId('tool-host')).toBeNull();
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'transcript');
    expect(hasOpenDialog()).toBe(false);
    // The hand-off is a CLEARING site (App.tsx's `showPanel`), not the
    // dialog's own `locked` → `false` transition — it releases the pass lock
    // directly, in the same synchronous handler, before React has even
    // re-rendered the (now-unmounted) dialog.
    expect(isPassRunning()).toBe(false);
    for (const button of within(strip()).getAllByRole('button')) {
      expect(button).not.toBeDisabled();
    }
  });

  /**
   * Fix round 1 (C3/M2) — OVERTURNS this test's old premise: `spatial.position`
   * used to be guarded because taking it mid-pass would unmount the running
   * tool and discard the pass exactly as switching module would. Under M2 a
   * module switch no longer discards anything, so `focusSpatialPanel` no
   * longer needs to be a special case — it backgrounds the tool exactly like
   * every other `showPanel` caller, and the pass keeps running. The invariant
   * ("a user's deliberate choice to leave never discards a running pass") is
   * preserved; it is now met by backgrounding rather than by refusal.
   */
  it('a deliberate choice to leave (Spatial Positioner) backgrounds the pass instead of discarding it (C3/M2)', async () => {
    await startPass();
    await openTool('spatial.position');

    expect(showMessageBox).not.toHaveBeenCalled();
    const node = screen.getByTestId('tool-host');
    expect(node).toHaveAttribute('data-backgrounded', 'true');
    expect(getRunningPass()?.label).toBe('Match Tempo');
    expect(isPassRunning()).toBe(true);
    expect(screen.getByTestId('sidebar-panel')).toHaveAttribute('data-active-tab', 'spatial');

    fireEvent.click(stripButton('Pipeline'));
    expect(screen.getByTestId('tool-host')).toBe(node);
    expect(screen.getByTestId('tool-host')).not.toHaveAttribute('data-backgrounded');
  });

  // M5 — the THIRD release guarantee (App.tsx's `[]`-scoped unmount effect),
  // on top of the twelve dialogs' own `finally` blocks and `DialogShell`'s own
  // unmount cleanup: if the whole App unmounts mid-pass, the lock must not
  // outlive it, or every OTHER window/session would be wedged permanently.
  it('never strands the pass lock when the app unmounts mid-pass', async () => {
    addDoc();
    const view = render(<App />);
    await openTool('tempo.match');
    fireEvent.click(screen.getByRole('button', { name: 'start pass' }));
    expect(hasOpenDialog()).toBe(false);
    expect(isPassRunning()).toBe(true);

    view.unmount();
    expect(hasOpenDialog()).toBe(false);
    expect(isPassRunning()).toBe(false);
  });
});

/**
 * Fix round 4 — the App-level refusal `handleToolModuleLock` surfaces when
 * `acquirePass` returns `null` (fix round 3, item 1). Round 3's report
 * claimed this was "exercised implicitly by every row of item 2's table"
 * (`hostedDialogsPassLock.test.tsx`); that claim was false, caught by the
 * round-4 review — that table renders each dialog STANDALONE with no
 * `DialogHostProvider`, so `useDialogHost()` returns `null`,
 * `host.onModuleLockChange` is never wired, and `handleToolModuleLock` is
 * never invoked there at all. Nothing else in the suite reached it either:
 * `App.pipelineHost`/`App.effectHost` render the real `<App/>` but never
 * call `acquirePass` themselves, so the race this branch exists for was
 * never constructed. This describe block is that construction, for real,
 * through `<App/>`.
 *
 * `StubTempoDialog` is exactly the fixture this needs: it flips `busy` with
 * NO gate of its own (unlike the real dialogs' `canApply`), so clicking
 * "start pass" while a FOREIGN pass already holds the lock reaches
 * `handleToolModuleLock(true)` with `acquirePass` guaranteed to fail —
 * reproducing the one gap fix round 1 could not close by dialog-side gating
 * alone (a hosted dialog whose own gate has a hole).
 */
describe('the App-level refusal when a hosted pass loses the acquire race (fix round 4)', () => {
  afterEach(() => {
    _resetPassLock();
  });

  it('names the FOREIGN pass, not the hosted one, and never lets the false-branch release free it', async () => {
    addDoc();
    render(<App />);
    await openTool('tempo.match'); // idle — nothing holds the lock yet

    let release: (() => void) | null = null;
    act(() => {
      release = acquirePass({ id: 'effects.coverChain', label: 'Cover Chain', kind: 'pipeline' });
    });
    expect(release).not.toBeNull();

    // The stub has no gate of its own: this flips `busy` (and so
    // `moduleLock`) regardless of the lock, exactly the case a real
    // dialog's own `canApply` is supposed to prevent from ever reaching here.
    fireEvent.click(screen.getByRole('button', { name: 'start pass' }));

    expect(showMessageBox).toHaveBeenCalledTimes(1);
    const [opts] = showMessageBox.mock.calls[0];
    // The FOREIGN blocker's name — `blockedByPassReason()` — never the
    // hosted dialog's own (`describeHostedPass()` would have said 'Match
    // Tempo', naming the wrong pass).
    expect(opts.message).toContain('Cover Chain');
    expect(opts.message).not.toContain('Match Tempo');
    expect(getRunningPass()?.label).toBe('Cover Chain');

    // The stub's own `busy` is still true (nothing here vetoed it), so this
    // is the tool's normal "finish" — the false branch of
    // `handleToolModuleLock`, exercised with `passReleaseRef.current` never
    // populated by the failed acquire above.
    fireEvent.click(screen.getByRole('button', { name: 'finish pass' }));

    // If the false-branch release had wrongly freed the foreign pass (the
    // exact defect this test exists to catch), this would now read `null`.
    expect(getRunningPass()?.label).toBe('Cover Chain');

    act(() => {
      release!();
    });
    expect(isPassRunning()).toBe(false);
  });
});
