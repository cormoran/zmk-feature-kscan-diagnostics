/**
 * Feature-detects zmk-feature-input-stream's custom RPC subsystem
 * (`zmk__input_stream`, SECURED — DESIGN.md §2/§7) and, when present and
 * unlocked, enables the live key-event stream and exposes a rolling event
 * log. Must degrade gracefully (not crash/hang) when the subsystem is
 * missing or the device is locked, so callers (TestWizard) can fall back to
 * stats-diff polling.
 */
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { MetaError } from "@zmkfirmware/zmk-studio-ts-client";
import { ErrorConditions } from "@zmkfirmware/zmk-studio-ts-client/meta";
import type { CustomNotification } from "@zmkfirmware/zmk-studio-ts-client/custom";
import {
  ZMKAppContext,
  ZMKCustomSubsystem,
} from "@cormoran/zmk-studio-react-hook";
import {
  Notification,
  Request,
  Response,
} from "./proto/zmk/input_stream/input_stream";

export const INPUT_STREAM_SUBSYSTEM_IDENTIFIER = "zmk__input_stream";

export interface KeyEvent {
  position: number;
  pressed: boolean;
  behaviorId: number;
  param1: number;
  param2: number;
  /**
   * Browser receive time (`performance.now()`), NOT a firmware timestamp:
   * input-stream notifications carry no timestamp and the queue drops
   * silently when full (DESIGN.md §1 limitation 2). Good enough for live
   * visualization; never use this for chatter/timing analysis — that comes
   * from this module's own stats RPC.
   */
  receivedAt: number;
}

const MAX_EVENT_LOG = 500;

export interface UseInputStreamReturn {
  /** Whether the `zmk__input_stream` subsystem was found on the device. */
  available: boolean;
  /** True once an RPC call against this subsystem failed with UNLOCK_REQUIRED. */
  locked: boolean;
  enabled: boolean;
  error: string | null;
  events: KeyEvent[];
  activeLayer: number;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  clearEvents: () => void;
}

export function useInputStream(): UseInputStreamReturn {
  const zmkApp = useContext(ZMKAppContext);
  const connection = zmkApp?.state.connection ?? null;
  const subsystem =
    zmkApp?.findSubsystem(INPUT_STREAM_SUBSYSTEM_IDENTIFIER) ?? null;

  const [locked, setLocked] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<KeyEvent[]>([]);
  const [activeLayer, setActiveLayer] = useState(0);

  // Best-effort disableStream on unmount / page close.
  const connectionRef = useRef(connection);
  const subsystemIndexRef = useRef<number | null>(subsystem?.index ?? null);
  const enabledRef = useRef(false);
  useEffect(() => {
    connectionRef.current = connection;
  }, [connection]);
  useEffect(() => {
    subsystemIndexRef.current = subsystem?.index ?? null;
  }, [subsystem]);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const sendRequest = useCallback(
    async (request: Request): Promise<Response | null> => {
      if (!connection || subsystem === null) return null;
      try {
        const service = new ZMKCustomSubsystem(connection, subsystem.index);
        const payload = Request.encode(request).finish();
        const respPayload = await service.callRPC(payload);
        setLocked(false);
        if (!respPayload) return null;
        const resp = Response.decode(respPayload);
        if (resp.error) {
          setError(resp.error.message);
          return resp;
        }
        setError(null);
        return resp;
      } catch (e) {
        if (
          e instanceof MetaError &&
          e.condition === ErrorConditions.UNLOCK_REQUIRED
        ) {
          setLocked(true);
        } else {
          setError(e instanceof Error ? e.message : "Unknown error");
        }
        return null;
      }
    },
    [connection, subsystem]
  );

  const enable = useCallback(async () => {
    const resp = await sendRequest(Request.create({ enableStream: {} }));
    if (resp && !resp.error) setEnabled(true);
  }, [sendRequest]);

  const disable = useCallback(async () => {
    const resp = await sendRequest(Request.create({ disableStream: {} }));
    if (resp && !resp.error) setEnabled(false);
    else if (!resp) setEnabled(false);
  }, [sendRequest]);

  useEffect(() => {
    const handler = () => {
      const conn = connectionRef.current;
      const idx = subsystemIndexRef.current;
      if (!enabledRef.current || !conn || idx === null) return;
      const service = new ZMKCustomSubsystem(conn, idx);
      const payload = Request.encode(
        Request.create({ disableStream: {} })
      ).finish();
      void service.callRPC(payload);
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  useEffect(() => {
    if (!zmkApp || !subsystem) return;
    const unsubscribe = zmkApp.onNotification({
      type: "custom",
      subsystemIndex: subsystem.index,
      callback: (notif: CustomNotification) => {
        try {
          const decoded = Notification.decode(notif.payload);
          if (decoded.keyEvent) {
            const { position, pressed, behaviorId, param1, param2 } =
              decoded.keyEvent;
            setEvents((prev) => {
              const next: KeyEvent[] = [
                {
                  position,
                  pressed,
                  behaviorId,
                  param1,
                  param2,
                  receivedAt: performance.now(),
                },
                ...prev,
              ];
              return next.length > MAX_EVENT_LOG
                ? next.slice(0, MAX_EVENT_LOG)
                : next;
            });
          }
          if (decoded.layerChange) {
            setActiveLayer(decoded.layerChange.layerIndex);
          }
        } catch {
          // Ignore malformed notifications rather than crashing the page.
        }
      },
    });
    return unsubscribe;
  }, [zmkApp, subsystem]);

  const clearEvents = useCallback(() => setEvents([]), []);

  return {
    available: subsystem !== null,
    locked,
    enabled,
    error,
    events,
    activeLayer,
    enable,
    disable,
    clearEvents,
  };
}
