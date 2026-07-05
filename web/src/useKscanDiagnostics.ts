/**
 * Data hook for this module's custom RPC subsystem
 * (`cormoran__kscan_diagnostics`, DESIGN.md §6-7).
 *
 * Sequences GetInfo -> GetLayout(s) -> GetDevice(s) -> paged
 * GetGpioPins/GetPositionMap into one assembled `Topology` object, and
 * exposes `getStats` (paged) / `resetStats`.
 */
import { useCallback, useContext, useMemo, useState } from "react";
import {
  ZMKAppContext,
  ZMKCustomSubsystem,
} from "@cormoran/zmk-studio-react-hook";
import {
  GpioLineKind,
  Request,
  Response,
} from "./proto/cormoran/kscan-diagnostics/kscan_diagnostics";
import type { GpioPin } from "./proto/cormoran/kscan-diagnostics/kscan_diagnostics";
import type {
  KscanDevice,
  KscanLayout,
  PositionStatsEntry,
  StatsByPosition,
  Topology,
} from "./kscanDiagnosticsTypes";

export const SUBSYSTEM_IDENTIFIER = "cormoran__kscan_diagnostics";

/**
 * Paging sizes are enforced firmware-side
 * (src/studio/kscan_diagnostics_handler.c's KSCAN_DIAGNOSTICS_RPC_*_PAGE_SIZE);
 * this hook just follows the `offset`/`total` fields the firmware returns
 * and doesn't need to know the page size itself.
 */
/** Safety valve so a misbehaving firmware (total never reached, or offset
 * never advances) cannot hang the UI in an infinite paging loop. */
const MAX_PAGES = 2000;

class KscanDiagnosticsRpcError extends Error {}

async function callRpc(
  service: ZMKCustomSubsystem,
  request: Request
): Promise<Response> {
  const payload = Request.encode(request).finish();
  const respPayload = await service.callRPC(payload);
  if (!respPayload) {
    throw new KscanDiagnosticsRpcError("No response from device");
  }
  const resp = Response.decode(respPayload);
  if (resp.error) {
    throw new KscanDiagnosticsRpcError(resp.error.message);
  }
  return resp;
}

async function fetchGpioPinsOfKind(
  service: ZMKCustomSubsystem,
  deviceIndex: number,
  kind: GpioLineKind
): Promise<GpioPin[]> {
  const pins: GpioPin[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const resp = await callRpc(service, {
      getGpioPins: { deviceIndex, kind, offset },
    });
    const chunk = resp.gpioPins;
    if (!chunk)
      throw new KscanDiagnosticsRpcError("Unexpected response to GetGpioPins");
    pins.push(...chunk.pins);
    offset = chunk.offset + chunk.pins.length;
    if (chunk.pins.length === 0 || offset >= chunk.total) break;
  }
  return pins;
}

/**
 * GpioPin (the response message) carries no kind field — kind is only a
 * GetGpioPins request-side filter (proto/.../kscan_diagnostics.proto) — so
 * fetch one paged sequence per kind to keep them separated for
 * `resolveRowColLines`. KIND_UNKNOWN is skipped: it means "unfiltered" on
 * the wire, which would duplicate lines already fetched per-kind.
 */
async function fetchGpioLinesByKind(
  service: ZMKCustomSubsystem,
  deviceIndex: number
): Promise<Record<GpioLineKind, GpioPin[]>> {
  const kinds: GpioLineKind[] = [
    GpioLineKind.ROW,
    GpioLineKind.COL,
    GpioLineKind.INPUT,
    GpioLineKind.OUTPUT,
    GpioLineKind.CHARLIE,
  ];
  const result = {} as Record<GpioLineKind, GpioPin[]>;
  result[GpioLineKind.KIND_UNKNOWN] = [];
  for (const kind of kinds) {
    result[kind] = await fetchGpioPinsOfKind(service, deviceIndex, kind);
  }
  return result;
}

async function fetchPositionMap(
  service: ZMKCustomSubsystem,
  layoutIndex: number
): Promise<(number | null)[]> {
  const cells: (number | null)[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const resp = await callRpc(service, {
      getPositionMap: { layoutIndex, offset },
    });
    const chunk = resp.positionMap;
    if (!chunk)
      throw new KscanDiagnosticsRpcError(
        "Unexpected response to GetPositionMap"
      );
    for (const cell of chunk.cells) {
      // 0 = unmapped, otherwise position+1 (DESIGN.md §6).
      cells.push(cell === 0 ? null : cell - 1);
    }
    offset = chunk.offset + chunk.cells.length;
    if (chunk.cells.length === 0 || offset >= chunk.total) break;
  }
  return cells;
}

async function fetchDevice(
  service: ZMKCustomSubsystem,
  deviceIndex: number
): Promise<KscanDevice> {
  const resp = await callRpc(service, { getDevice: { deviceIndex } });
  const d = resp.device;
  if (!d)
    throw new KscanDiagnosticsRpcError("Unexpected response to GetDevice");
  const gpioLinesByKind = await fetchGpioLinesByKind(service, deviceIndex);
  return {
    deviceIndex: d.deviceIndex,
    nodeName: d.nodeName,
    type: d.type,
    rows: d.rows,
    columns: d.columns,
    inputs: d.inputs,
    debouncePressMs: d.debouncePressMs,
    debounceReleaseMs: d.debounceReleaseMs,
    debounceScanPeriodMs: d.debounceScanPeriodMs,
    pollPeriodMs: d.pollPeriodMs,
    diodeRow2col: d.diodeRow2col,
    toggleMode: d.toggleMode,
    gpioLinesByKind,
  };
}

async function fetchLayout(
  service: ZMKCustomSubsystem,
  layoutIndex: number
): Promise<KscanLayout> {
  const resp = await callRpc(service, { getLayout: { layoutIndex } });
  const l = resp.layout;
  if (!l)
    throw new KscanDiagnosticsRpcError("Unexpected response to GetLayout");
  const positionMap = await fetchPositionMap(service, layoutIndex);
  return {
    layoutIndex: l.layoutIndex,
    displayName: l.displayName,
    rows: l.rows,
    columns: l.columns,
    keyCount: l.keyCount,
    deviceIndices: l.deviceIndices.map((d) => ({
      leafIndex: d.leafIndex,
      rowOffset: d.rowOffset,
      colOffset: d.colOffset,
    })),
    positionMap,
  };
}

async function fetchTopology(service: ZMKCustomSubsystem): Promise<Topology> {
  const infoResp = await callRpc(service, { getInfo: {} });
  const info = infoResp.info;
  if (!info)
    throw new KscanDiagnosticsRpcError("Unexpected response to GetInfo");

  const layouts: KscanLayout[] = [];
  for (let i = 0; i < info.layoutCount; i++) {
    layouts.push(await fetchLayout(service, i));
  }

  // Discover the set of device indices actually referenced by layouts; every
  // device in device_count is still fetched so the wiring overlay works even
  // for devices not attached to the active layout (multi-layout keyboards).
  const devices: KscanDevice[] = [];
  for (let i = 0; i < info.deviceCount; i++) {
    devices.push(await fetchDevice(service, i));
  }

  return {
    protoVersion: info.protoVersion,
    selectedLayout: info.selectedLayout,
    statsEnabled: info.statsEnabled,
    maxPositions: info.maxPositions,
    uptimeMs: info.uptimeMs,
    devices,
    layouts,
  };
}

async function fetchStats(
  service: ZMKCustomSubsystem
): Promise<StatsByPosition> {
  const byPosition: StatsByPosition = new Map();
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const resp = await callRpc(service, { getStats: { offset } });
    const chunk = resp.stats;
    if (!chunk)
      throw new KscanDiagnosticsRpcError("Unexpected response to GetStats");
    for (const e of chunk.entries) {
      const entry: PositionStatsEntry = {
        position: e.position,
        presses: e.presses,
        releases: e.releases,
        minPressDurationMs: e.minPressDurationMs,
        minRepressGapMs: e.minRepressGapMs,
        repressLt5: e.repressLt5,
        repressLt10: e.repressLt10,
        repressLt20: e.repressLt20,
        repressLt50: e.repressLt50,
        lastSource: e.lastSource,
      };
      byPosition.set(entry.position, entry);
    }
    offset = chunk.offset + chunk.entries.length;
    if (chunk.entries.length === 0 || offset >= chunk.total) break;
  }
  return byPosition;
}

export interface UseKscanDiagnosticsReturn {
  /** Whether the `cormoran__kscan_diagnostics` subsystem was found on the device. */
  available: boolean;
  topology: Topology | null;
  stats: StatsByPosition | null;
  isLoading: boolean;
  error: string | null;
  /** (Re-)fetch the full topology. */
  loadTopology: () => Promise<void>;
  /**
   * (Re-)fetch stats for every position; also returns the freshly-fetched
   * map directly so callers (e.g. TestWizard's baseline/after snapshots)
   * don't have to read back through `stats` state, which may still hold the
   * previous value in the same render/closure.
   */
  loadStats: () => Promise<StatsByPosition>;
  /** Reset all firmware-side counters, then re-fetch stats. */
  resetStats: () => Promise<void>;
}

export function useKscanDiagnostics(): UseKscanDiagnosticsReturn {
  const zmkApp = useContext(ZMKAppContext);
  const connection = zmkApp?.state.connection ?? null;
  const subsystem = zmkApp?.findSubsystem(SUBSYSTEM_IDENTIFIER) ?? null;

  const [topology, setTopology] = useState<Topology | null>(null);
  const [stats, setStats] = useState<StatsByPosition | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const service = useMemo(() => {
    if (!connection || !subsystem) return null;
    return new ZMKCustomSubsystem(connection, subsystem.index);
  }, [connection, subsystem]);

  const loadTopology = useCallback(async () => {
    if (!service) return;
    setIsLoading(true);
    setError(null);
    try {
      const t = await fetchTopology(service);
      setTopology(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setIsLoading(false);
    }
  }, [service]);

  const loadStats = useCallback(async () => {
    if (!service) return new Map();
    setError(null);
    try {
      const s = await fetchStats(service);
      setStats(s);
      return s;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
      return new Map();
    }
  }, [service]);

  const resetStats = useCallback(async () => {
    if (!service) return;
    setError(null);
    try {
      await callRpc(service, { resetStats: {} });
      await loadStats();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    }
  }, [service, loadStats]);

  return {
    available: subsystem !== null,
    topology,
    stats,
    isLoading,
    error,
    loadTopology,
    loadStats,
    resetStats,
  };
}
