import { useEffect, useState, type CSSProperties } from 'react';
import { Check } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';
import {
  getRemixAnalysis,
  getTempo,
  isTempoRunning,
  regridTempo,
  useTempoVersion,
} from '../../services/tempoAnalysis';
import { commandReason, isCommandEnabled, multitrackToolDoc, runCommand } from '../../services/menuActions';
import { PASS_REFUSED, runExclusivePass, usePassLock } from '../../services/passLock';

/** The SAME descriptor `tempo.detect`'s menu command acquires
 * (`menuActions.ts`'s `registerTempoCommands`) — Re-detect below reuses it
 * already through `runCommand('tempo.detect')`; ×2/÷2 need it directly since
 * they call `regridTempo` themselves rather than going through the menu. */
const TEMPO_DETECT_PASS = { id: 'tempo.detect', label: 'Detect Tempo', kind: 'pipeline' } as const;
import { useSessionStore } from '../../multitrack/sessionStore';
import { CONFIDENCE_LOW } from '../../dsp/tempoCore';
import { clusterColor, meterLabel, structureRuns } from '../../utils/structureStrip';
import { GlassCard } from '../UI/glass';
import { formatTime } from '../../utils/timeFormat';

const LOW_CONFIDENCE_TITLE =
  'Low confidence tempo estimate — may be wrong (e.g. an octave error) or the material may not be percussive.';

/** Mockup `.mono`. */
const monoStyle: CSSProperties = {
  fontVariantNumeric: 'tabular-nums',
  fontFamily: 'Consolas, monospace',
};

/** Mockup `.chip`: small chrome chip, hover states via .glass-pill-btn. */
const chipStyle: CSSProperties = {
  border: '1px solid var(--glass-border)',
  background: 'rgba(255,255,255,.04)',
  borderRadius: 7,
  padding: '2px 9px',
  fontSize: 11,
  color: 'var(--glass-text-secondary)',
  cursor: 'pointer',
};

/** Mockup `.chip.accent`, non-interactive (a status, not a control). */
const accentChipStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  background: 'var(--accent-soft)',
  color: 'var(--accent)',
  border: '1px solid transparent',
  boxShadow: '0 0 0 1px var(--accent-ring)',
  borderRadius: 7,
  padding: '2px 9px',
  fontSize: 11,
};

/**
 * G4: the small persistent TEMPO card above the panel card (the approved
 * mockup's strip card). STRICTLY a cached read — `getTempo`/`getRemixAnalysis`
 * only, never `runTempoAnalysis` — so rendering it costs nothing and it stays
 * hidden until some real flow (Detect Tempo, Auto-Remix, tempo.detect) has
 * produced an analysis for the active document.
 *
 *  - `♩ BPM · meter · conf` readout: BPM with the SAME `*` stale / `?`
 *    uncertainty markers the status pill uses (they are tested contracts of
 *    the readout language); the meter appears only when a remix-level
 *    analysis exists (TempoAnalysis alone does not know a meter — never
 *    invent one).
 *  - Cluster-coloured structure strip when a remix analysis exists — the
 *    SAME `structureRuns`/cluster colours as the Auto-Remix dialog.
 *  - ×2 / ÷2 / Re-detect chips wired to the EXISTING mechanisms: octave
 *    correction goes through `regridTempo` (T2 carry-forward: re-track the
 *    grid, never relabel the number — PropertiesPanel's exact convention,
 *    including the inverse period mapping), Re-detect through the existing
 *    `tempo.detect` command. ×2/÷2 hide on a stale/BPM-less entry (nothing
 *    trustworthy to correct — PropertiesPanel's gating), Re-detect stays.
 */
export default function TempoCard() {
  // FIRST — run start/progress/completion/invalidation re-render this card
  // (module-state store, not zustand; StatusBar.tsx precedent).
  useTempoVersion();
  // Lot M: same reason, for the app-wide pass lock — called unconditionally,
  // ahead of the early `return null` below, like every other hook here.
  // Final fix wave (item 13): the return value is now READ — the x2/÷2 chips
  // below used to gate on `running` alone (this document's OWN tempo flag),
  // a stale-parallel-variable exactly like the one this card's own doc
  // comment (Fix round 1, finding 5) already corrected for "which document".
  // `regridTempo` spawns the same Worker `tempo.detect` already locks.
  const runningPass = usePassLock();
  // Fix round 1 (finding 5) — this card must show the SAME document
  // `tempo.detect` would actually analyse, or "Re-detect"/"this document" is
  // a stale-parallel-variable lie the moment a clip is selected in
  // multitrack. `multitrackToolDoc` is the shared resolver `tempo.detect`'s
  // own run body reads; its multitrack arm reads the session store
  // (`clipPassTarget()`), which the `useAppStore` selector below cannot see
  // on its own — the same freshness gap `PipelinePanel.tsx`/`EffectsPanel.tsx`
  // close with these same two selectors.
  useSessionStore((s) => s.session);
  useSessionStore((s) => s.selectedClipIds);
  const doc = useAppStore((s) => multitrackToolDoc(s));
  const [correctionFailed, setCorrectionFailed] = useState(false);

  // A different document is a different grid — a failure note must not carry
  // across a switch.
  useEffect(() => {
    setCorrectionFailed(false);
  }, [doc?.id]);

  const entry = doc ? getTempo(doc) : null;
  if (!doc || !entry) return null;

  const remix = getRemixAnalysis(doc);
  const runs = structureRuns(remix);
  const running = isTempoRunning(doc.id);
  const canCorrect = entry.bpm !== null && !entry.stale;
  const uncertain = entry.bpm !== null && entry.confidence < CONFIDENCE_LOW;

  const bpmText =
    entry.bpm === null
      ? '♩ —'
      : `♩ ${entry.bpm.toFixed(1)}${entry.stale ? '*' : ''}${uncertain ? '?' : ''}`;
  const readout =
    entry.bpm === null
      ? bpmText
      : [bpmText, remix ? meterLabel(remix.beatsPerBar) : null, `conf ${entry.confidence.toFixed(2)}`]
          .filter(Boolean)
          .join(' · ');

  // Final fix wave, second round — HOLDS the lock, not merely refuses on
  // it: user-initiated tempo work, the same rule `tempo.detect`'s own menu
  // row and PropertiesPanel's `TempoSection` follow.
  async function correct(newPeriodFrames: number): Promise<void> {
    if (!doc) return;
    setCorrectionFailed(false);
    const result = await runExclusivePass(TEMPO_DETECT_PASS, () => regridTempo(doc.id, newPeriodFrames));
    if (result === PASS_REFUSED) return; // defence in depth — the button is already disabled for this
    setCorrectionFailed(result === null);
  }

  return (
    <GlassCard
      data-testid="tempo-card"
      className="pointer-events-auto shrink-0"
      style={{ padding: '12px 16px 10px' }}
    >
      <div className="flex items-baseline justify-between" style={{ gap: 10, marginBottom: 8 }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '1.4px',
            textTransform: 'uppercase',
            color: 'var(--accent)',
          }}
        >
          Tempo
        </span>
        <span
          data-testid="tempo-card-readout"
          title={uncertain ? LOW_CONFIDENCE_TITLE : undefined}
          style={{ ...monoStyle, fontSize: 11.5, color: 'var(--glass-text-secondary)' }}
        >
          {readout}
        </span>
      </div>

      {runs.length > 0 && (
        <div
          data-testid="tempo-card-structure"
          className="flex overflow-hidden"
          style={{ height: 26, borderRadius: 8, marginBottom: 8 }}
        >
          {runs.map((run, i) => (
            <div
              key={i}
              data-testid="tempo-card-block"
              title={`${formatTime(run.startSample, doc.sampleRate)} – ${formatTime(run.endSample, doc.sampleRate)}`}
              style={{
                width: `${Math.round(run.widthPercent * 1000) / 1000}%`,
                backgroundColor: clusterColor(run.cluster),
              }}
            />
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center" style={{ gap: 6 }}>
        {canCorrect && (
          <>
            <button
              type="button"
              aria-label="Double tempo"
              title="Double tempo (×2) — re-tracks the beat grid"
              disabled={running || runningPass !== null}
              onClick={() => void correct(entry.periodFrames / 2)}
              className="glass-pill-btn"
              style={chipStyle}
            >
              ×2
            </button>
            <button
              type="button"
              aria-label="Halve tempo"
              title="Halve tempo (÷2) — re-tracks the beat grid"
              disabled={running || runningPass !== null}
              onClick={() => void correct(entry.periodFrames * 2)}
              className="glass-pill-btn"
              style={chipStyle}
            >
              ÷2
            </button>
          </>
        )}
        <button
          type="button"
          aria-label="Re-detect tempo"
          title={commandReason('tempo.detect') ?? 'Re-run tempo detection on this document'}
          disabled={running || !isCommandEnabled('tempo.detect')}
          onClick={() => void runCommand('tempo.detect')}
          className="glass-pill-btn"
          style={chipStyle}
        >
          Re-detect
        </button>
        {remix?.tempoConfirmed && (
          <span data-testid="tempo-card-confirmed" style={{ ...accentChipStyle, marginLeft: 'auto' }}>
            <Check size={11} /> confirmed
          </span>
        )}
      </div>

      {correctionFailed && (
        <div
          data-testid="tempo-card-correction-failed"
          className="text-xs"
          style={{ marginTop: 6, color: '#e0a458' }}
        >
          Correction failed — grid unchanged.
        </div>
      )}
    </GlassCard>
  );
}
