/**
 * Wraps the official ZMK Studio protocol's `keymap.getPhysicalLayouts` and
 * `keymap.getKeymap` calls (DESIGN.md §7) — the same data zmk.studio uses to
 * render the keyboard, so KeyboardView doesn't duplicate layout knowledge.
 */
import { useCallback, useContext, useState } from "react";
import { call_rpc, MetaError } from "@zmkfirmware/zmk-studio-ts-client";
import { ErrorConditions } from "@zmkfirmware/zmk-studio-ts-client/meta";
import type { Keymap, PhysicalLayouts } from "@zmkfirmware/zmk-studio-ts-client/keymap";
import { ZMKAppContext } from "@cormoran/zmk-studio-react-hook";

export interface UseOfficialKeymapReturn {
  physicalLayouts: PhysicalLayouts | null;
  keymap: Keymap | null;
  isLoading: boolean;
  /** True when the last load failed because Studio is locked (needs `&studio_unlock`). */
  unlockRequired: boolean;
  error: string | null;
  load: () => Promise<void>;
}

export function useOfficialKeymap(): UseOfficialKeymapReturn {
  const zmkApp = useContext(ZMKAppContext);
  const connection = zmkApp?.state.connection ?? null;

  const [physicalLayouts, setPhysicalLayouts] = useState<PhysicalLayouts | null>(null);
  const [keymap, setKeymap] = useState<Keymap | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [unlockRequired, setUnlockRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!connection) return;
    setIsLoading(true);
    setError(null);
    try {
      const [layoutResp, keymapResp] = await Promise.all([
        call_rpc(connection, { keymap: { getPhysicalLayouts: true } }),
        call_rpc(connection, { keymap: { getKeymap: true } }),
      ]);
      setUnlockRequired(false);
      if (layoutResp.keymap?.getPhysicalLayouts) {
        setPhysicalLayouts(layoutResp.keymap.getPhysicalLayouts);
      }
      if (keymapResp.keymap?.getKeymap) {
        setKeymap(keymapResp.keymap.getKeymap);
      }
    } catch (e) {
      if (e instanceof MetaError && e.condition === ErrorConditions.UNLOCK_REQUIRED) {
        setUnlockRequired(true);
      } else {
        setError(e instanceof Error ? e.message : "Unknown error");
      }
    } finally {
      setIsLoading(false);
    }
  }, [connection]);

  return { physicalLayouts, keymap, isLoading, unlockRequired, error, load };
}
