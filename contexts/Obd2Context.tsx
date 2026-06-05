import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
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

  useEffect(() => {
    obd2.init();
    const offStatus = obd2.onStatus((s, msg) => {
      setStatus(s);
      setStatusMessage(msg);
    });
    const offDevices = obd2.onDevices(setDevices);
    const offLive = obd2.onLive(setLiveData);
    return () => {
      offStatus();
      offDevices();
      offLive();
    };
  }, []);

  return (
    <Obd2Context.Provider
      value={{
        status,
        statusMessage,
        devices,
        liveData,
        isConnected: status === "connected",
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
    };
  }
  return ctx;
}
