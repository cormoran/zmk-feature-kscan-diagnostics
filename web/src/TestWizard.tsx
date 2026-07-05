/**
 * Test wizard state machine (DESIGN.md §7 screen 3): coverage pass, retest
 * pass for missed keys, chatter check, and a report screen driven by the
 * DiagnosisEngine.
 *
 * Live coverage tracking uses `useInputStream` events when available;
 * otherwise it falls back to polling `GetStats` at ~2 Hz and diffing press
 * counts against the snapshot taken when the pass started (DESIGN.md §7).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { diagnose } from "./diagnosis/engine";
import type {
  CellWiring,
  DiagnosisKeyEvent,
  Finding,
  PositionCoverage,
} from "./diagnosis/types";
import type { StatsByPosition } from "./kscanDiagnosticsTypes";

export type WizardPhase = "idle" | "coverage" | "retest" | "chatter" | "report";

export type ChatterBucket = "lt5" | "lt10" | "lt20" | "lt50";

export interface TestWizardProps {
  /** All cells (positions) of the layout under test, with resolved wiring. */
  cells: CellWiring[];
  /** Fetch a fresh stats snapshot on demand (from useKscanDiagnostics). */
  fetchStats: () => Promise<StatsByPosition>;
  /** Live input-stream event log, if available (empty array when not). */
  liveEvents: DiagnosisKeyEvent[];
  /** Whether live input-stream events are usable right now. */
  liveAvailable: boolean;
  /** Called whenever the wizard wants the current coverage map, for KeyboardView highlighting. */
  onCoverageChange?: (coverage: Map<number, PositionCoverage>) => void;
}

const POLL_INTERVAL_MS = 500;

function pressCountFor(stats: StatsByPosition, position: number): number {
  return stats.get(position)?.presses ?? 0;
}

export function TestWizard({
  cells,
  fetchStats,
  liveEvents,
  liveAvailable,
  onCoverageChange,
}: TestWizardProps) {
  const [phase, setPhase] = useState<WizardPhase>("idle");
  const [coverage, setCoverage] = useState<Map<number, PositionCoverage>>(
    new Map()
  );
  const [statsBaseline, setStatsBaseline] = useState<StatsByPosition | null>(
    null
  );
  const [statsAfter, setStatsAfter] = useState<StatsByPosition | null>(null);
  const [chatterBucket, setChatterBucket] = useState<ChatterBucket>("lt50");
  const [findings, setFindings] = useState<Finding[]>([]);
  const [error, setError] = useState<string | null>(null);

  const liveEventsSeenCountRef = useRef(0);

  const positionsUnderTest = useMemo(
    () => cells.map((c) => c.position),
    [cells]
  );

  const initCoverage = useCallback((): Map<number, PositionCoverage> => {
    const map = new Map<number, PositionCoverage>();
    for (const p of positionsUnderTest) {
      map.set(p, { position: p, status: "untested", pressCount: 0 });
    }
    return map;
  }, [positionsUnderTest]);

  useEffect(() => {
    onCoverageChange?.(coverage);
  }, [coverage, onCoverageChange]);

  const markSeen = useCallback((position: number) => {
    setCoverage((prev) => {
      const next = new Map(prev);
      const existing = next.get(position) ?? {
        position,
        status: "untested",
        pressCount: 0,
      };
      next.set(position, {
        ...existing,
        status: "seen",
        pressCount: existing.pressCount + 1,
      });
      return next;
    });
  }, []);

  // Live-event-driven coverage: consume new entries appended to liveEvents
  // (useInputStream prepends newest-first, so only scan the prefix we
  // haven't processed yet).
  useEffect(() => {
    if (phase !== "coverage" && phase !== "retest") return;
    if (!liveAvailable) return;
    const newCount = liveEvents.length - liveEventsSeenCountRef.current;
    if (newCount <= 0) {
      liveEventsSeenCountRef.current = liveEvents.length;
      return;
    }
    const newOnes = liveEvents.slice(0, newCount);
    liveEventsSeenCountRef.current = liveEvents.length;
    for (const ev of newOnes) {
      if (ev.pressed) markSeen(ev.position);
    }
  }, [liveEvents, liveAvailable, phase, markSeen]);

  // Stats-diff polling fallback when live events are unavailable.
  useEffect(() => {
    if (liveAvailable) return;
    if (phase !== "coverage" && phase !== "retest") return;
    if (!statsBaseline) return;
    let cancelled = false;
    const id = setInterval(() => {
      void (async () => {
        try {
          const current = await fetchStats();
          if (cancelled) return;
          setCoverage((prev) => {
            const next = new Map(prev);
            for (const [position, cov] of prev) {
              const before = pressCountFor(statsBaseline, position);
              const now = pressCountFor(current, position);
              if (now > before) {
                next.set(position, {
                  ...cov,
                  status: "seen",
                  pressCount: now - before,
                });
              }
            }
            return next;
          });
        } catch {
          // transient poll failure; keep polling
        }
      })();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [liveAvailable, phase, statsBaseline, fetchStats]);

  const startCoverage = useCallback(async () => {
    setError(null);
    liveEventsSeenCountRef.current = liveEvents.length;
    setCoverage(initCoverage());
    if (!liveAvailable) {
      try {
        setStatsBaseline(await fetchStats());
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Failed to fetch baseline stats"
        );
      }
    }
    setPhase("coverage");
  }, [initCoverage, liveAvailable, liveEvents.length, fetchStats]);

  const missedPositions = useMemo(
    () =>
      [...coverage.values()]
        .filter((c) => c.status !== "seen")
        .map((c) => c.position),
    [coverage]
  );

  const finishCoverage = useCallback(() => {
    setCoverage((prev) => {
      const next = new Map(prev);
      for (const [position, cov] of prev) {
        if (cov.status === "untested")
          next.set(position, { ...cov, status: "missed" });
      }
      return next;
    });
    setPhase("retest");
  }, []);

  const finishRetest = useCallback(async () => {
    setError(null);
    try {
      const after = await fetchStats();
      setStatsAfter(after);
      setPhase("chatter");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch stats");
    }
  }, [fetchStats]);

  const runDiagnosis = useCallback(() => {
    if (!statsAfter) return;
    const result = diagnose({
      cells,
      coverage: [...coverage.values()],
      statsBefore: statsBaseline ?? undefined,
      statsAfter,
      eventLog: liveEvents,
      chatterBucket,
      requestedPositions: new Set(positionsUnderTest),
    });
    setFindings(result);
    setPhase("report");
  }, [
    statsAfter,
    cells,
    coverage,
    statsBaseline,
    liveEvents,
    chatterBucket,
    positionsUnderTest,
  ]);

  const restart = useCallback(() => {
    setPhase("idle");
    setCoverage(new Map());
    setStatsBaseline(null);
    setStatsAfter(null);
    setFindings([]);
    setError(null);
  }, []);

  const seenCount = [...coverage.values()].filter(
    (c) => c.status === "seen"
  ).length;

  return (
    <div className="test-wizard">
      {error && <div className="error-bar">{error}</div>}

      {phase === "idle" && (
        <div className="wizard-step">
          <p>
            Press <strong>every key once</strong> to check coverage. The wizard
            uses{" "}
            {liveAvailable
              ? "live key events"
              : "stats polling (live events unavailable)"}{" "}
            to track which keys registered.
          </p>
          <button
            className="btn btn-primary"
            onClick={() => void startCoverage()}
          >
            Start test
          </button>
        </div>
      )}

      {phase === "coverage" && (
        <div className="wizard-step">
          <h3>Coverage pass</h3>
          <p>
            Press every key once. {seenCount} / {positionsUnderTest.length}{" "}
            seen.
          </p>
          <button className="btn btn-primary" onClick={finishCoverage}>
            Done pressing / show missed keys
          </button>
        </div>
      )}

      {phase === "retest" && (
        <div className="wizard-step">
          <h3>Retest pass</h3>
          {missedPositions.length === 0 ? (
            <p>All keys were seen during the coverage pass.</p>
          ) : (
            <p>
              Press each of these positions 5 times:{" "}
              <strong>{missedPositions.join(", ")}</strong>
            </p>
          )}
          <button
            className="btn btn-primary"
            onClick={() => void finishRetest()}
          >
            Done retesting / continue
          </button>
        </div>
      )}

      {phase === "chatter" && (
        <div className="wizard-step">
          <h3>Chatter check</h3>
          <label>
            Threshold bucket:{" "}
            <select
              value={chatterBucket}
              onChange={(e) =>
                setChatterBucket(e.target.value as ChatterBucket)
              }
            >
              <option value="lt5">&lt; 5ms</option>
              <option value="lt10">&lt; 10ms</option>
              <option value="lt20">&lt; 20ms</option>
              <option value="lt50">&lt; 50ms</option>
            </select>
          </label>
          <div>
            <button className="btn btn-primary" onClick={runDiagnosis}>
              Generate report
            </button>
          </div>
        </div>
      )}

      {phase === "report" && (
        <div className="wizard-step">
          <h3>Report</h3>
          {findings.length === 0 ? (
            <p>
              No faults detected. If a key still misbehaves, check its keymap
              binding.
            </p>
          ) : (
            <ul className="findings-list">
              {findings.map((f, i) => (
                <li
                  key={i}
                  className={`finding finding-${f.confidence}`}
                  data-testid="finding"
                >
                  <div className="finding-header">
                    <span className="finding-kind">{f.kind}</span>
                    <span className="finding-confidence">{f.confidence}</span>
                  </div>
                  <p className="finding-summary">{f.summary}</p>
                  <p className="finding-action">{f.action}</p>
                  <details>
                    <summary>Evidence</summary>
                    <ul>
                      {f.evidence.map((e, j) => (
                        <li key={j}>{e}</li>
                      ))}
                    </ul>
                  </details>
                </li>
              ))}
            </ul>
          )}
          <button className="btn btn-secondary" onClick={restart}>
            Start over
          </button>
        </div>
      )}
    </div>
  );
}
