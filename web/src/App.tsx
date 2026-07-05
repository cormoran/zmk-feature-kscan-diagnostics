import { useContext, useEffect, useMemo, useState } from "react";
import "./App.css";
import { connect as serial_connect } from "@zmkfirmware/zmk-studio-ts-client/transport/serial";
import { ZMKConnection, ZMKAppContext } from "@cormoran/zmk-studio-react-hook";
import {
  useKscanDiagnostics,
  SUBSYSTEM_IDENTIFIER,
} from "./useKscanDiagnostics";
import {
  useInputStream,
  INPUT_STREAM_SUBSYSTEM_IDENTIFIER,
} from "./useInputStream";
import { useOfficialKeymap } from "./useOfficialKeymap";
import { KeyboardView, type KeyState } from "./KeyboardView";
import { TestWizard } from "./TestWizard";
import { StatsTable } from "./StatsTable";
import { buildCellWiring, buildWiringMap } from "./kscanDiagnosticsTypes";
import type { PositionCoverage } from "./diagnosis/types";

export { SUBSYSTEM_IDENTIFIER };

function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1>🔧 Kscan Diagnostics</h1>
        <p>Diagnose broken wires, bad solder joints, and switch chatter</p>
      </header>

      <ZMKConnection
        renderDisconnected={({ connect, isLoading, error }) => (
          <section className="card">
            <h2>Device Connection</h2>
            {isLoading && <p>⏳ Connecting...</p>}
            {error && (
              <div className="error-message">
                <p>🚨 {error}</p>
              </div>
            )}
            {!isLoading && (
              <button
                className="btn btn-primary"
                onClick={() => connect(serial_connect)}
              >
                🔌 Connect Serial
              </button>
            )}
          </section>
        )}
        renderConnected={({ disconnect, deviceName }) => (
          <>
            <section className="card">
              <h2>Device Connection</h2>
              <div className="device-info">
                <h3>✅ Connected to: {deviceName}</h3>
              </div>
              <button className="btn btn-secondary" onClick={disconnect}>
                Disconnect
              </button>
            </section>

            <DiagnosticsSections />
          </>
        )}
      />

      <footer className="app-footer">
        <p>
          <strong>Kscan Diagnostics</strong> — hardware fault diagnosis for ZMK
          keyboards
        </p>
      </footer>
    </div>
  );
}

function DiagnosticsSections() {
  const zmkApp = useContext(ZMKAppContext);
  const kscan = useKscanDiagnostics();
  const inputStream = useInputStream();
  const officialKeymap = useOfficialKeymap();

  const [wiringMode, setWiringMode] = useState(false);
  const [wizardCoverage, setWizardCoverage] = useState<
    Map<number, PositionCoverage>
  >(new Map());

  // Load everything once on connect.
  useEffect(() => {
    void kscan.loadTopology();
    void kscan.loadStats();
    void officialKeymap.load();
    // Only re-run if the connection itself changes (findSubsystem/etc. are
    // stable per render already handled inside the hooks).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zmkApp?.state.connection]);

  const activeLayout = useMemo(() => {
    if (!kscan.topology) return null;
    return (
      kscan.topology.layouts.find(
        (l) => l.layoutIndex === kscan.topology!.selectedLayout
      ) ??
      kscan.topology.layouts[0] ??
      null
    );
  }, [kscan.topology]);

  const cells = useMemo(() => {
    if (!kscan.topology || !activeLayout) return [];
    return buildCellWiring(kscan.topology, activeLayout);
  }, [kscan.topology, activeLayout]);

  const wiring = useMemo(() => {
    if (!kscan.topology || !activeLayout) return new Map();
    return buildWiringMap(kscan.topology, activeLayout);
  }, [kscan.topology, activeLayout]);

  const physicalLayout = useMemo(() => {
    if (!officialKeymap.physicalLayouts) return null;
    return (
      officialKeymap.physicalLayouts.layouts[
        officialKeymap.physicalLayouts.activeLayoutIndex
      ] ??
      officialKeymap.physicalLayouts.layouts[0] ??
      null
    );
  }, [officialKeymap.physicalLayouts]);

  const keyStates = useMemo(() => {
    const states = new Map<number, KeyState>();
    for (const [position, cov] of wizardCoverage) {
      if (cov.status === "seen") states.set(position, "ok");
      else if (cov.status === "missed") states.set(position, "dead");
    }
    for (const ev of inputStream.events) {
      if (ev.pressed) states.set(ev.position, "pressed");
    }
    return states;
  }, [wizardCoverage, inputStream.events]);

  if (!zmkApp) return null;

  return (
    <>
      {!kscan.available && (
        <section className="card">
          <div className="warning-message">
            <p>
              ⚠️ Subsystem "{SUBSYSTEM_IDENTIFIER}" not found. Make sure your
              firmware includes the kscan-diagnostics module.
            </p>
          </div>
        </section>
      )}

      {kscan.error && (
        <section className="card">
          <div className="error-message">
            <p>🚨 {kscan.error}</p>
          </div>
        </section>
      )}

      {!inputStream.available && (
        <section className="card">
          <p className="hint-text">
            Live key-event streaming ("{INPUT_STREAM_SUBSYSTEM_IDENTIFIER}") is
            not available — falling back to stats-diff polling for coverage
            tracking.
          </p>
        </section>
      )}
      {inputStream.locked && (
        <section className="card">
          <p className="hint-text">
            Studio is locked — bind &amp;studio_unlock to a key to enable the
            live event stream (falling back to stats-diff polling meanwhile).
          </p>
        </section>
      )}

      {physicalLayout && (
        <section className="card">
          <h2>Keyboard</h2>
          <KeyboardView
            layout={physicalLayout}
            keyStates={keyStates}
            wiring={wiring}
            wiringMode={wiringMode}
            onToggleWiringMode={() => setWiringMode((v) => !v)}
          />
        </section>
      )}

      {kscan.available && cells.length > 0 && (
        <section className="card">
          <h2>Test Wizard</h2>
          <TestWizard
            cells={cells}
            fetchStats={kscan.loadStats}
            liveEvents={inputStream.events}
            liveAvailable={inputStream.available && !inputStream.locked}
            onCoverageChange={setWizardCoverage}
          />
        </section>
      )}

      {kscan.available && (
        <section className="card">
          <h2>Stats</h2>
          <StatsTable
            stats={kscan.stats}
            onRefresh={() => void kscan.loadStats()}
            onReset={() => void kscan.resetStats()}
            isLoading={kscan.isLoading}
          />
        </section>
      )}
    </>
  );
}

export default App;
