import { fireEvent, render, screen } from "@testing-library/react";
import type { PhysicalLayout } from "@zmkfirmware/zmk-studio-ts-client/keymap";
import { KeyboardView, type KeyState } from "../src/KeyboardView";
import {
  KscanDriverType,
  GpioLineKind,
} from "../src/proto/cormoran/kscan_diagnostics/kscan_diagnostics";
import { buildWiringMap } from "../src/kscanDiagnosticsTypes";
import type {
  KscanDevice,
  KscanLayout,
  Topology,
} from "../src/kscanDiagnosticsTypes";

function makeLayout(count: number): PhysicalLayout {
  return {
    name: "test",
    keys: Array.from({ length: count }, (_, i) => ({
      width: 100,
      height: 100,
      x: (i % 3) * 110,
      y: Math.floor(i / 3) * 110,
      r: 0,
      rx: 0,
      ry: 0,
    })),
  };
}

function makeDevice(overrides: Partial<KscanDevice> = {}): KscanDevice {
  return {
    deviceIndex: 0,
    nodeName: "kscan0",
    type: KscanDriverType.MATRIX,
    rows: 3,
    columns: 3,
    inputs: 0,
    debouncePressMs: 5,
    debounceReleaseMs: 5,
    debounceScanPeriodMs: 10,
    pollPeriodMs: 0,
    diodeRow2col: true,
    toggleMode: false,
    gpioLinesByKind: {
      [GpioLineKind.KIND_UNKNOWN]: [],
      [GpioLineKind.ROW]: [
        { index: 0, port: "gpio0", pin: 0, activeLow: true, dtFlags: 0 },
        { index: 1, port: "gpio0", pin: 1, activeLow: true, dtFlags: 0 },
        { index: 2, port: "gpio0", pin: 2, activeLow: true, dtFlags: 0 },
      ],
      [GpioLineKind.COL]: [
        { index: 3, port: "gpio1", pin: 0, activeLow: true, dtFlags: 0 },
        { index: 4, port: "gpio1", pin: 1, activeLow: true, dtFlags: 0 },
        { index: 5, port: "gpio1", pin: 2, activeLow: true, dtFlags: 0 },
      ],
      [GpioLineKind.INPUT]: [],
      [GpioLineKind.OUTPUT]: [],
      [GpioLineKind.CHARLIE]: [],
    },
    ...overrides,
  };
}

function makeTopology(): Topology {
  const layout: KscanLayout = {
    layoutIndex: 0,
    displayName: "default",
    rows: 3,
    columns: 3,
    keyCount: 9,
    deviceIndices: [{ leafIndex: 0, rowOffset: 0, colOffset: 0 }],
    positionMap: [0, 1, 2, 3, 4, 5, 6, 7, 8],
  };
  return {
    protoVersion: 1,
    selectedLayout: 0,
    statsEnabled: true,
    maxPositions: 9,
    uptimeMs: 0,
    devices: [makeDevice()],
    layouts: [layout],
  };
}

describe("KeyboardView", () => {
  it("renders a keycap per physical key", () => {
    const layout = makeLayout(9);
    const keyStates = new Map<number, KeyState>();
    render(
      <KeyboardView
        layout={layout}
        keyStates={keyStates}
        wiring={new Map()}
        wiringMode={false}
        onToggleWiringMode={() => {}}
      />
    );
    for (let i = 0; i < 9; i++) {
      expect(screen.getByTestId(`keycap-${i}`)).toBeInTheDocument();
    }
  });

  it("shows hover info with row/col and GPIO line when hovering a wired key", () => {
    const topology = makeTopology();
    const layout = makeLayout(9);
    const wiring = buildWiringMap(topology, topology.layouts[0]);

    render(
      <KeyboardView
        layout={layout}
        keyStates={new Map()}
        wiring={wiring}
        wiringMode={false}
        onToggleWiringMode={() => {}}
      />
    );

    fireEvent.mouseEnter(screen.getByTestId("keycap-4"));
    const info = screen.getByTestId("hover-info");
    expect(info.textContent).toContain("row 1, col 1");
    expect(info.textContent).toContain("gpio0 pin 1");
    expect(info.textContent).toContain("gpio1 pin 1");
  });

  it("toggles wiring mode via the toolbar button", () => {
    const onToggle = jest.fn();
    render(
      <KeyboardView
        layout={makeLayout(1)}
        keyStates={new Map()}
        wiring={new Map()}
        wiringMode={false}
        onToggleWiringMode={onToggle}
      />
    );
    fireEvent.click(screen.getByText(/Wiring mode: off/i));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("applies the dead-key state to a keycap", () => {
    const keyStates = new Map<number, KeyState>([[0, "dead"]]);
    render(
      <KeyboardView
        layout={makeLayout(1)}
        keyStates={keyStates}
        wiring={new Map()}
        wiringMode={false}
        onToggleWiringMode={() => {}}
      />
    );
    expect(screen.getByTestId("keycap-0")).toHaveAttribute(
      "data-state",
      "dead"
    );
  });
});

describe("buildWiringMap", () => {
  it("resolves row/col GPIO lines for every mapped position", () => {
    const topology = makeTopology();
    const wiring = buildWiringMap(topology, topology.layouts[0]);
    expect(wiring.size).toBe(9);
    const pos4 = wiring.get(4);
    expect(pos4?.row).toBe(1);
    expect(pos4?.column).toBe(1);
    expect(pos4?.rowLine).toEqual({ port: "gpio0", pin: 1 });
    expect(pos4?.colLine).toEqual({ port: "gpio1", pin: 1 });
  });

  it("skips unmapped cells", () => {
    const topology = makeTopology();
    topology.layouts[0].positionMap[0] = null;
    const wiring = buildWiringMap(topology, topology.layouts[0]);
    expect(wiring.has(0)).toBe(false);
    expect(wiring.size).toBe(8);
  });
});
