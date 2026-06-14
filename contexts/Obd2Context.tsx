import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import {
  obd2,
  type ConnectionStatus,
  type DiscoveredDevice,
  type LiveData,
} from "../lib/obd2";

// React context wrapper around the obd2 singleton — exposes connection state
// and live data to any screen, so the "live data available" badge in Ask
// Vulcan and the "Diagnose with Vulcan" hand-off in the OBD2 screen all
// react to the same source of truth.

interface Obd2State {
  status: ConnectionStatus;
  statusMessage: string;
  devices: DiscoveredDevice[];
  liveData: LiveData;
  isConnected: boolean;
  // Ground-truth connected-vehicle VIN (Mode-09), reactive — resolves AFTER
  // status "connected", clears on disconnect. The clean "connected + what is it"
  // signal the unified-flow merge (SB3+) reads.
  connectedVin: string | null;
}

const Obd2Context = createContext<Obd2State | null>(null);

export function Obd2Provider({ children }: { children: ReactNode }) {
  const initial = obd2.getStatus();
  const [status, setStatus] = useState<ConnectionStatus>(initial.status);
  const [statusMessage, setStatusMessage] = useState(initial.message);
  const [devices, setDevices] = useState<DiscoveredDevice[]>(
    obd2.getDiscovered(),
  );
  const [liveData, setLiveData] = useState<LiveData>(obd2.getLiveData());
  const [connectedVin, setConnectedVin] = useState<string | null>(
    obd2.getConnectedVin(),
  );

  useEffect(() => {
    obd2.init();
    const offStatus = obd2.onStatus((s, msg) => {
      setStatus(s);
      setStatusMessage(msg);
    });
    const offDevices = obd2.onDevices(setDevices);
    const offLive = obd2.onLive(setLiveData);
    const offVin = obd2.onVin(setConnectedVin);
    return () => {
      offStatus();
      offDevices();
      offLive();
      offVin();
    };
  }, []);

  // App-level auto-reconnect owner (SB2-B). Fire the single gated, mutex-safe
  // ensureAutoReconnect on launch and whenever the app returns to the
  // foreground, so any screen — Diagnose especially — sees a connected vehicle
  // without the tech first visiting the OBD2 Scan screen. ensureAutoReconnect is
  // a no-op when already connected/connecting, with no remembered adapter, or
  // when permissions aren't already granted (no cold-launch prompt); the connect
  // mutex coalesces it with any screen-level trigger.
  useEffect(() => {
    obd2.ensureAutoReconnect().catch(() => {});
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") obd2.ensureAutoReconnect().catch(() => {});
    });
    return () => sub.remove();
  }, []);

  return (
    <Obd2Context.Provider
      value={{
        status,
        statusMessage,
        devices,
        liveData,
        isConnected: status === "connected",
        connectedVin,
      }}
    >
      {children}
    </Obd2Context.Provider>
  );
}

export function useObd2(): Obd2State {
  const ctx = useContext(Obd2Context);
  if (!ctx) {
    // Defensive default — if a screen accidentally renders outside the
    // provider, it'll see "disconnected" rather than crashing.
    return {
      status: "idle",
      statusMessage: "",
      devices: [],
      liveData: obd2.getLiveData(),
      isConnected: false,
      connectedVin: null,
    };
  }
  return ctx;
}
