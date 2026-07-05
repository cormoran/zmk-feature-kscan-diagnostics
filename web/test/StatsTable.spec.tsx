import { fireEvent, render, screen } from "@testing-library/react";
import { StatsTable } from "../src/StatsTable";
import { statsToCsv } from "../src/statsCsv";
import type {
  PositionStatsEntry,
  StatsByPosition,
} from "../src/kscanDiagnosticsTypes";

function makeEntry(
  overrides: Partial<PositionStatsEntry> = {}
): PositionStatsEntry {
  return {
    position: 0,
    presses: 1,
    releases: 1,
    minPressDurationMs: 50,
    minRepressGapMs: 0xffff,
    repressLt5: 0,
    repressLt10: 0,
    repressLt20: 0,
    repressLt50: 0,
    lastSource: 255,
    ...overrides,
  };
}

function makeStats(entries: PositionStatsEntry[]): StatsByPosition {
  return new Map(entries.map((e) => [e.position, e]));
}

describe("StatsTable", () => {
  it("shows a hint when no stats are loaded", () => {
    render(<StatsTable stats={null} onRefresh={() => {}} onReset={() => {}} />);
    expect(screen.getByText(/No stats loaded yet/i)).toBeInTheDocument();
  });

  it("renders one row per position, sorted", () => {
    const stats = makeStats([
      makeEntry({ position: 2 }),
      makeEntry({ position: 0 }),
    ]);
    render(
      <StatsTable stats={stats} onRefresh={() => {}} onReset={() => {}} />
    );
    const rows = screen.getAllByRole("row");
    // header + 2 data rows
    expect(rows).toHaveLength(3);
    expect(screen.getByTestId("stats-row-0")).toBeInTheDocument();
    expect(screen.getByTestId("stats-row-2")).toBeInTheDocument();
  });

  it("renders '-' for sentinel 0xFFFF duration/gap fields", () => {
    const stats = makeStats([makeEntry({ position: 0 })]);
    render(
      <StatsTable stats={stats} onRefresh={() => {}} onReset={() => {}} />
    );
    const row = screen.getByTestId("stats-row-0");
    expect(row.textContent).toContain("-");
  });

  it("calls onRefresh and onReset", () => {
    const onRefresh = jest.fn();
    const onReset = jest.fn();
    render(<StatsTable stats={null} onRefresh={onRefresh} onReset={onReset} />);
    fireEvent.click(screen.getByText("Refresh"));
    fireEvent.click(screen.getByText("Reset counters"));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("disables export when there are no stats", () => {
    render(<StatsTable stats={null} onRefresh={() => {}} onReset={() => {}} />);
    expect(screen.getByText("Export CSV")).toBeDisabled();
  });
});

describe("statsToCsv", () => {
  it("produces a header row plus one row per position, sorted by position", () => {
    const stats = makeStats([
      makeEntry({ position: 1, presses: 3, repressLt50: 2 }),
      makeEntry({ position: 0, presses: 5 }),
    ]);
    const csv = statsToCsv(stats);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(
      "position,presses,releases,min_press_duration_ms,min_repress_gap_ms,repress_lt5,repress_lt10,repress_lt20,repress_lt50,last_source"
    );
    expect(lines[1]).toContain("0,5,");
    expect(lines[2]).toContain("1,3,");
  });
});
