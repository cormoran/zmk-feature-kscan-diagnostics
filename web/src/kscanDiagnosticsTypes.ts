/**
 * Assembled, UI-friendly view over the cormoran__kscan_diagnostics custom RPC
 * subsystem (DESIGN.md §6-7). The raw generated messages
 * (`./proto/cormoran/kscan-diagnostics/kscan_diagnostics`) are paged and
 * fragmented on the wire; `useKscanDiagnostics` sequences the paging and
 * assembles the shapes below for the rest of the app to consume.
 */
import {
  GpioLineKind,
  KscanDriverType,
} from "./proto/cormoran/kscan-diagnostics/kscan_diagnostics";
import type { GpioPin } from "./proto/cormoran/kscan-diagnostics/kscan_diagnostics";

export interface KscanDevice {
  deviceIndex: number;
  nodeName: string;
  type: KscanDriverType;
  rows: number;
  columns: number;
  inputs: number;
  debouncePressMs: number;
  debounceReleaseMs: number;
  debounceScanPeriodMs: number;
  pollPeriodMs: number;
  diodeRow2col: boolean;
  toggleMode: boolean;
  /** All GPIO lines for this device (ROW/COL/INPUT/OUTPUT/CHARLIE), unfiltered. */
  gpioLines: GpioPin[];
}

export interface KscanLayoutDevice {
  leafIndex: number;
  rowOffset: number;
  colOffset: number;
}

export interface KscanLayout {
  layoutIndex: number;
  displayName: string;
  rows: number;
  columns: number;
  keyCount: number;
  deviceIndices: KscanLayoutDevice[];
  /**
   * Row-major over rows x columns; value is a zero-based keymap position, or
   * `null` when the (row, column) cell has no transform entry (unmapped —
   * DESIGN.md §1 known limitation 4: ghost presses on unmapped cells are
   * invisible).
   */
  positionMap: (number | null)[];
}

export interface Topology {
  protoVersion: number;
  selectedLayout: number;
  statsEnabled: boolean;
  maxPositions: number;
  uptimeMs: number;
  devices: KscanDevice[];
  layouts: KscanLayout[];
}

/** Resolve which device+line drives the row and column of a keyboard position. */
export interface PositionWiring {
  position: number;
  row: number;
  column: number;
  device: KscanDevice | null;
  layoutDevice: KscanLayoutDevice | null;
  /** GPIO line for this cell's row (matrix/charlieplex) — null for direct/demux without a row concept. */
  rowLine: GpioPin | null;
  /** GPIO line for this cell's column. */
  colLine: GpioPin | null;
}

export { GpioLineKind, KscanDriverType };

export interface PositionStatsEntry {
  position: number;
  presses: number;
  releases: number;
  minPressDurationMs: number;
  minRepressGapMs: number;
  repressLt5: number;
  repressLt10: number;
  repressLt20: number;
  repressLt50: number;
  lastSource: number;
}

export type StatsByPosition = Map<number, PositionStatsEntry>;
