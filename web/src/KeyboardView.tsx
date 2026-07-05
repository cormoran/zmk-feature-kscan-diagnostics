/**
 * SVG rendering of the physical layout (DESIGN.md §7 screen 2): per-key fill
 * by diagnostic state, with a "wiring mode" toggle overlaying row/col GPIO
 * groupings so a whole broken line is visually obvious. Hover/click a key
 * shows (row, col), its row/col GPIO port+pin, and debounce config.
 */
import { useMemo, useState } from "react";
import type {
  KeyPhysicalAttrs,
  PhysicalLayout,
} from "@zmkfirmware/zmk-studio-ts-client/keymap";
import type { KeyWiringInfo } from "./kscanDiagnosticsTypes";

export type KeyState =
  | "untested"
  | "ok"
  | "pressed"
  | "suspect"
  | "dead"
  | "unmapped";

const KEY_STATE_COLORS: Record<KeyState, string> = {
  untested: "#e5e7eb",
  ok: "#86efac",
  pressed: "#facc15",
  suspect: "#fdba74",
  dead: "#f87171",
  unmapped: "#d1d5db",
};

/** Deterministic color per GPIO line, derived from its port+pin so the same
 * physical line always gets the same wiring-mode color across renders. */
function colorForLine(label: string): string {
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

function layoutBounds(keys: KeyPhysicalAttrs[]): {
  maxX: number;
  maxY: number;
} {
  let maxX = 0;
  let maxY = 0;
  for (const k of keys) {
    if (k.r === 0) {
      maxX = Math.max(maxX, k.x + k.width);
      maxY = Math.max(maxY, k.y + k.height);
    } else {
      const rad = (k.r / 100) * (Math.PI / 180);
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const corners = [
        [k.x, k.y],
        [k.x + k.width, k.y],
        [k.x + k.width, k.y + k.height],
        [k.x, k.y + k.height],
      ];
      for (const [cx, cy] of corners) {
        const dx = cx - k.rx;
        const dy = cy - k.ry;
        maxX = Math.max(maxX, k.rx + dx * cos - dy * sin);
        maxY = Math.max(maxY, k.ry + dx * sin + dy * cos);
      }
    }
  }
  return { maxX, maxY };
}

export interface KeyboardViewProps {
  layout: PhysicalLayout;
  /** State per key index (index into `layout.keys`, which matches keymap position). */
  keyStates: Map<number, KeyState>;
  wiring: Map<number, KeyWiringInfo>;
  wiringMode: boolean;
  onToggleWiringMode: () => void;
}

const LAYOUT_MAX_PX = 760;
const SCALE_MIN = 0.28;
const SCALE_MAX = 0.65;

export function KeyboardView({
  layout,
  keyStates,
  wiring,
  wiringMode,
  onToggleWiringMode,
}: KeyboardViewProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  const { maxX, maxY } = useMemo(
    () => layoutBounds(layout.keys),
    [layout.keys]
  );
  const scale =
    maxX > 0
      ? Math.max(SCALE_MIN, Math.min(SCALE_MAX, LAYOUT_MAX_PX / maxX))
      : 0.48;

  const hoveredInfo = hovered !== null ? wiring.get(hovered) : null;

  return (
    <div className="keyboard-view">
      <div className="keyboard-view-toolbar">
        <button
          className={`btn btn-sm ${wiringMode ? "btn-primary" : "btn-secondary"}`}
          onClick={onToggleWiringMode}
        >
          {wiringMode ? "Wiring mode: on" : "Wiring mode: off"}
        </button>
        {hoveredInfo && (
          <span className="keyboard-view-hover-info" data-testid="hover-info">
            pos {hoveredInfo.position}: row {hoveredInfo.row}, col{" "}
            {hoveredInfo.column}
            {hoveredInfo.rowLine
              ? ` | row line ${hoveredInfo.rowLine.port} pin ${hoveredInfo.rowLine.pin}`
              : ""}
            {hoveredInfo.colLine
              ? ` | col line ${hoveredInfo.colLine.port} pin ${hoveredInfo.colLine.pin}`
              : ""}
            {hoveredInfo.device
              ? ` | debounce press ${hoveredInfo.device.debouncePressMs}ms / release ${hoveredInfo.device.debounceReleaseMs}ms`
              : ""}
          </span>
        )}
      </div>
      <div
        className="keyboard-layout"
        style={{
          width: Math.ceil(maxX * scale) + 2,
          height: Math.ceil(maxY * scale) + 2,
        }}
      >
        {layout.keys.map((key, i) => {
          const state = keyStates.get(i) ?? "untested";
          const info = wiring.get(i);
          return (
            <KeyCap
              key={i}
              position={i}
              keyAttrs={key}
              scale={scale}
              state={state}
              wiringMode={wiringMode}
              wiring={info ?? null}
              onHover={setHovered}
            />
          );
        })}
      </div>
    </div>
  );
}

interface KeyCapProps {
  position: number;
  keyAttrs: KeyPhysicalAttrs;
  scale: number;
  state: KeyState;
  wiringMode: boolean;
  wiring: KeyWiringInfo | null;
  onHover: (position: number | null) => void;
}

function KeyCap({
  position,
  keyAttrs,
  scale,
  state,
  wiringMode,
  wiring,
  onHover,
}: KeyCapProps) {
  const { x, y, width, height, r, rx, ry } = keyAttrs;
  const deg = r / 100;
  const originX = (rx - x) * scale;
  const originY = (ry - y) * scale;

  const background = wiringMode ? undefined : KEY_STATE_COLORS[state];
  const rowColor =
    wiringMode && wiring?.rowLine
      ? colorForLine(`row:${wiring.rowLine.port}:${wiring.rowLine.pin}`)
      : undefined;
  const colColor =
    wiringMode && wiring?.colLine
      ? colorForLine(`col:${wiring.colLine.port}:${wiring.colLine.pin}`)
      : undefined;

  return (
    <div
      className={`keycap keycap-${state}`}
      data-testid={`keycap-${position}`}
      data-state={state}
      onMouseEnter={() => onHover(position)}
      onMouseLeave={() => onHover(null)}
      style={{
        left: x * scale,
        top: y * scale,
        width: width * scale,
        height: height * scale,
        backgroundColor: background,
        borderTopColor: rowColor,
        borderBottomColor: rowColor,
        borderLeftColor: colColor,
        borderRightColor: colColor,
        borderWidth: wiringMode ? 3 : undefined,
        borderStyle: wiringMode ? "solid" : undefined,
        ...(deg !== 0 && {
          transform: `rotate(${deg}deg)`,
          transformOrigin: `${originX}px ${originY}px`,
        }),
      }}
      title={
        wiring
          ? `pos ${position}: row ${wiring.row}, col ${wiring.column}`
          : `pos ${position}: unmapped`
      }
    >
      <span className="keycap-label">{position}</span>
    </div>
  );
}
