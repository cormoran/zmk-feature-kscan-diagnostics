import { act, fireEvent, render, screen } from "@testing-library/react";
import { TestWizard } from "../src/TestWizard";
import { KscanDriverType } from "../src/proto/cormoran/kscan-diagnostics/kscan_diagnostics";
import type { CellWiring, DiagnosisKeyEvent } from "../src/diagnosis/types";
import type {
  PositionStatsEntry,
  StatsByPosition,
} from "../src/kscanDiagnosticsTypes";

function makeCells(count: number): CellWiring[] {
  return Array.from({ length: count }, (_, i) => ({
    position: i,
    row: Math.floor(i / 3),
    column: i % 3,
    deviceType: KscanDriverType.MATRIX,
    rowLine: {
      index: 0,
      port: "gpio0",
      pin: Math.floor(i / 3),
      activeLow: true,
      dtFlags: 0,
    },
    colLine: {
      index: 1,
      port: "gpio1",
      pin: i % 3,
      activeLow: true,
      dtFlags: 0,
    },
  }));
}

function makeStatsEntry(
  overrides: Partial<PositionStatsEntry> = {}
): PositionStatsEntry {
  return {
    position: 0,
    presses: 0,
    releases: 0,
    minPressDurationMs: 0xffff,
    minRepressGapMs: 0xffff,
    repressLt5: 0,
    repressLt10: 0,
    repressLt20: 0,
    repressLt50: 0,
    lastSource: 255,
    ...overrides,
  };
}

function makeStatsMap(
  count: number,
  presses: (i: number) => number
): StatsByPosition {
  const map = new Map<number, PositionStatsEntry>();
  for (let i = 0; i < count; i++) {
    map.set(i, makeStatsEntry({ position: i, presses: presses(i) }));
  }
  return map;
}

describe("TestWizard", () => {
  it("walks coverage -> retest -> chatter -> report using live events", async () => {
    const cells = makeCells(9);
    let liveEvents: DiagnosisKeyEvent[] = [];
    const fetchStats = jest.fn().mockResolvedValue(makeStatsMap(9, () => 1));

    const { rerender } = render(
      <TestWizard
        cells={cells}
        fetchStats={fetchStats}
        liveEvents={liveEvents}
        liveAvailable={true}
      />
    );

    fireEvent.click(screen.getByText("Start test"));
    expect(screen.getByText(/Coverage pass/i)).toBeInTheDocument();

    // Simulate 8 of 9 keys pressed via live events (position 4 missed).
    liveEvents = [8, 7, 6, 5, 3, 2, 1, 0].map((position) => ({
      position,
      pressed: true,
      receivedAt: 0,
    }));
    rerender(
      <TestWizard
        cells={cells}
        fetchStats={fetchStats}
        liveEvents={liveEvents}
        liveAvailable={true}
      />
    );
    expect(screen.getByText(/8 \/ 9 seen/i)).toBeInTheDocument();

    fireEvent.click(screen.getByText(/Done pressing/i));
    expect(screen.getByText(/Retest pass/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Press each of these positions 5 times/i).textContent
    ).toContain("4");

    await act(async () => {
      fireEvent.click(screen.getByText(/Done retesting/i));
    });
    expect(fetchStats).toHaveBeenCalled();
    expect(screen.getByText(/Chatter check/i)).toBeInTheDocument();

    fireEvent.click(screen.getByText("Generate report"));
    expect(screen.getByText(/Report/i)).toBeInTheDocument();
  });

  it("falls back to stats-diff polling when live events are unavailable", async () => {
    jest.useFakeTimers();
    const cells = makeCells(4);
    let callCount = 0;
    const fetchStats = jest.fn().mockImplementation(() => {
      callCount++;
      // First call is the baseline (all zero); subsequent calls show
      // position 0 pressed once.
      if (callCount === 1) return Promise.resolve(makeStatsMap(4, () => 0));
      return Promise.resolve(makeStatsMap(4, (i) => (i === 0 ? 1 : 0)));
    });

    render(
      <TestWizard
        cells={cells}
        fetchStats={fetchStats}
        liveEvents={[]}
        liveAvailable={false}
      />
    );

    await act(async () => {
      fireEvent.click(screen.getByText("Start test"));
    });
    expect(fetchStats).toHaveBeenCalledTimes(1); // baseline fetch

    await act(async () => {
      jest.advanceTimersByTime(600);
      await Promise.resolve();
    });

    expect(screen.getByText(/1 \/ 4 seen/i)).toBeInTheDocument();
    jest.useRealTimers();
  });

  it("shows 'no faults detected' when diagnosis finds nothing", async () => {
    const cells = makeCells(4);
    const fetchStats = jest.fn().mockResolvedValue(makeStatsMap(4, () => 1));
    render(
      <TestWizard
        cells={cells}
        fetchStats={fetchStats}
        liveEvents={[]}
        liveAvailable={true}
      />
    );

    fireEvent.click(screen.getByText("Start test"));
    fireEvent.click(screen.getByText(/Done pressing/i));
    await act(async () => {
      fireEvent.click(screen.getByText(/Done retesting/i));
    });
    fireEvent.click(screen.getByText("Generate report"));

    expect(screen.getByText(/No faults detected/i)).toBeInTheDocument();
  });

  it("reports coverage changes via onCoverageChange", () => {
    const cells = makeCells(2);
    const fetchStats = jest.fn().mockResolvedValue(new Map());
    const onCoverageChange = jest.fn();
    render(
      <TestWizard
        cells={cells}
        fetchStats={fetchStats}
        liveEvents={[]}
        liveAvailable={true}
        onCoverageChange={onCoverageChange}
      />
    );
    expect(onCoverageChange).toHaveBeenCalled();
  });
});
