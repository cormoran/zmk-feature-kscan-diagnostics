/**
 * Shared fixtures for DiagnosisEngine rule tests: a 3x3 matrix keyboard
 * (positions 0-8, row-major) with GPIO lines gpio0 pin 0-2 (rows) and
 * gpio1 pin 0-2 (columns).
 */
import { KscanDriverType } from "../../src/proto/cormoran/kscan_diagnostics/kscan_diagnostics";
import type { GpioPin } from "../../src/proto/cormoran/kscan_diagnostics/kscan_diagnostics";
import type { PositionStatsEntry } from "../../src/kscanDiagnosticsTypes";
import type {
  CellWiring,
  DiagnosisKeyEvent,
  PositionCoverage,
} from "../../src/diagnosis/types";

export const ROWS = 3;
export const COLS = 3;

function rowLine(row: number): GpioPin {
  return { index: row, port: "gpio0", pin: row, activeLow: true, dtFlags: 0 };
}
function colLine(col: number): GpioPin {
  return {
    index: 100 + col,
    port: "gpio1",
    pin: col,
    activeLow: true,
    dtFlags: 0,
  };
}

export function makeCells(
  deviceType: KscanDriverType = KscanDriverType.MATRIX
): CellWiring[] {
  const cells: CellWiring[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      cells.push({
        position: row * COLS + col,
        row,
        column: col,
        deviceType,
        rowLine: rowLine(row),
        colLine: colLine(col),
      });
    }
  }
  return cells;
}

export function positionFor(row: number, col: number): number {
  return row * COLS + col;
}

/** Coverage where every position is "seen" with 1 press, except overridden. */
export function makeCoverage(
  overrides: Record<number, Partial<PositionCoverage>> = {}
): PositionCoverage[] {
  const coverage: PositionCoverage[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const position = positionFor(row, col);
      coverage.push({
        position,
        status: "seen",
        pressCount: 1,
        ...overrides[position],
      });
    }
  }
  return coverage;
}

export function makeStatsEntry(
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

export function makeStatsMap(
  entries: Partial<PositionStatsEntry>[] = []
): Map<number, PositionStatsEntry> {
  const map = new Map<number, PositionStatsEntry>();
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const position = positionFor(row, col);
      map.set(position, makeStatsEntry({ position }));
    }
  }
  for (const override of entries) {
    if (override.position === undefined) continue;
    map.set(
      override.position,
      makeStatsEntry({ ...map.get(override.position), ...override })
    );
  }
  return map;
}

export function makeEvent(
  overrides: Partial<DiagnosisKeyEvent> = {}
): DiagnosisKeyEvent {
  return { position: 0, pressed: true, receivedAt: 0, ...overrides };
}
