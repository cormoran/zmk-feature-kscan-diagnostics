/** Pure CSV serialization for the stats table (kept out of StatsTable.tsx so
 * that file only exports the component, per react-refresh/only-export-components). */
import type { StatsByPosition } from "./kscanDiagnosticsTypes";

const CSV_HEADER = [
  "position",
  "presses",
  "releases",
  "min_press_duration_ms",
  "min_repress_gap_ms",
  "repress_lt5",
  "repress_lt10",
  "repress_lt20",
  "repress_lt50",
  "last_source",
];

export function statsToCsv(stats: StatsByPosition): string {
  const rows = [...stats.values()].sort((a, b) => a.position - b.position);
  const lines = [CSV_HEADER.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.position,
        r.presses,
        r.releases,
        r.minPressDurationMs,
        r.minRepressGapMs,
        r.repressLt5,
        r.repressLt10,
        r.repressLt20,
        r.repressLt50,
        r.lastSource,
      ].join(",")
    );
  }
  return lines.join("\n") + "\n";
}
