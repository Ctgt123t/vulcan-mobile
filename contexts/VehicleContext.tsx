import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Alert } from "react-native";
import { decodeVin } from "../lib/api";
import { obd2 } from "../lib/obd2";
import { fetchPidCatalog, saveCatalog } from "../lib/pidCatalog";
import { fetchRecalls } from "../lib/recalls";
import { fetchTsbs } from "../lib/tsbs";
import type { Recall, Tsb, VehicleInfo } from "../lib/types";

// ----------------------------------------------------------------------------
// Global vehicle state. Holds the currently-known vehicle plus its recalls
// and TSBs so any screen can show the same Vehicle Bar without re-fetching.
//
// Auto-VIN flow: when the OBD2 manager reports "connected", we ask it for
// Mode 09 PID 02 (the VIN), decode via NHTSA, and populate the vehicle.
// Existing manual entry continues to work via setVehicleManually(). If a
// manual vehicle was already entered and the OBD2 VIN decodes to something
// different, the tech is prompted to choose.
//
// Persistence: vehicle + vin + source go to AsyncStorage so the last known
// vehicle survives app restarts (techs typically work on one vehicle for
// a while). Recalls and TSBs are NOT persisted — they're cheap to refetch
// and the NHTSA data could change.
//
// Scaling note (per CLAUDE.md): state is entirely client-side. The backend
// /api/pids/... cache warming is keyed by make/model/year, not per-user,
// so it doesn't add per-user load.
// ----------------------------------------------------------------------------

export const EMPTY_VEHICLE: VehicleInfo = {
  year: "",
  make: "",
  model: "",
  trim: "",
  engineType: "",
  mileage: "",
};

export type VehicleSource = "manual" | "vin-decoded" | "obd2-auto" | null;

interface VehicleState {
  vehicle: VehicleInfo;
  vin: string | null;
  source: VehicleSource;
  recalls: Recall[];
  tsbs: Tsb[];
  lookupBusy: boolean;
  setVehicleManually: (vehicle: VehicleInfo, vin?: string | null) => Promise<void>;
  clearVehicle: () => Promise<void>;
}

const STORAGE_KEY = "vulcan:vehicle:v1";

const VehicleContext = createContext<VehicleState | null>(null);

interface PersistedShape {
  vehicle: VehicleInfo;
  vin: string | null;
  source: VehicleSource;
}

function vehiclesDiffer(a: VehicleInfo, b: VehicleInfo): boolean {
  const norm = (s: string | undefined) => (s ?? "").trim().toLowerCase();
  return (
    norm(a.year) !== norm(b.year) ||
    norm(a.make) !== norm(b.make) ||
    norm(a.model) !== norm(b.model)
  );
}

function vehicleHasIdentity(v: VehicleInfo): boolean {
  return Boolean(v.year?.trim() && v.make?.trim() && v.model?.trim());
}

function formatVehicleShort(v: VehicleInfo): string {
  return [v.year, v.make, v.model].filter((s) => s && s.trim()).join(" ");
}

export function VehicleProvider({ children }: { children: ReactNode }) {
  const [vehicle, setVehicleState] = useState<VehicleInfo>(EMPTY_VEHICLE);
  const [vin, setVin] = useState<string | null>(null);
  const [source, setSource] = useState<VehicleSource>(null);
  const [recalls, setRecalls] = useState<Recall[]>([]);
  const [tsbs, setTsbs] = useState<Tsb[]>([]);
  const [lookupBusy, setLookupBusy] = useState(false);

  // Keep the latest state in refs so the OBD2-status listener can read
  // current values without re-subscribing every change.
  const vehicleRef = useRef(vehicle);
  const vinRef = useRef(vin);
  const sourceRef = useRef(source);
  useEffect(() => {
    vehicleRef.current = vehicle;
    vinRef.current = vin;
    sourceRef.current = source;
  }, [vehicle, vin, source]);

  // Persist core identity (recalls/TSBs intentionally not persisted).
  const persist = useCallback(
    async (v: VehicleInfo, vinValue: string | null, src: VehicleSource) => {
      try {
        const payload: PersistedShape = { vehicle: v, vin: vinValue, source: src };
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch (err) {
        console.warn("[vehicleCtx] persist failed:", err);
      }
    },
    [],
  );

  // Pull recalls + TSBs in parallel and prefetch the PID database for this
  // vehicle so the cache is warm when the live-diagnostic feature lands.
  // Debounced by year/make/model key so per-keystroke vehicle edits during
  // the Diagnose intake form don't fan out to a fetch every character.
  const lastFetchedKey = useRef<string>("");
  const refreshMetadata = useCallback(async (v: VehicleInfo) => {
    if (!vehicleHasIdentity(v)) {
      setRecalls([]);
      setTsbs([]);
      lastFetchedKey.current = "";
      return;
    }
    const key = `${v.year.trim()}|${v.make.trim().toLowerCase()}|${v.model.trim().toLowerCase()}`;
    if (lastFetchedKey.current === key) return;
    lastFetchedKey.current = key;
    setLookupBusy(true);
    try {
      const [r, t] = await Promise.all([
        fetchRecalls(v.year, v.make, v.model).catch(() => [] as Recall[]),
        fetchTsbs(v.year, v.make, v.model).catch(() => [] as Tsb[]),
      ]);
      setRecalls(r);
      setTsbs(t);
    } finally {
      setLookupBusy(false);
    }
    // PID catalog prefetch — DB-2: fetch AND PERSIST the catalog to the phone's
    // per-vehicle cache (vulcan:pids:catalog:<make|model|year>), not just warm
    // the backend. Previously this was a raw fetch that only warmed the server,
    // so the phone catalog cache was written ONLY by the PID picker screen —
    // leaving startCaptureRound (the capture flow) unable to load it on any
    // Diagnose-first / app-level-connect flow (defect Issue 2). Persisting it
    // here, on every vehicle change (which fires on connect + VIN decode), is
    // the lifted-app-wide catalog load the SB2 merge deferred. Fire-and-forget;
    // saveCatalog keys identically to loadCachedCatalog so the capture flow finds
    // it. saveCatalog also warms the server cache as a side effect of the fetch.
    if (v.year && v.make && v.model) {
      fetchPidCatalog(v.make, v.model, v.year)
        .then((catalog) => {
          if (catalog) saveCatalog(catalog).catch(() => {});
        })
        .catch(() => {});
    }
  }, []);

  const setVehicleManually = useCallback(
    async (v: VehicleInfo, vinValue: string | null = null) => {
      setVehicleState(v);
      setVin(vinValue);
      setSource(vehicleHasIdentity(v) ? "manual" : null);
      await persist(v, vinValue, vehicleHasIdentity(v) ? "manual" : null);
      await refreshMetadata(v);
    },
    [persist, refreshMetadata],
  );

  const clearVehicle = useCallback(async () => {
    setVehicleState(EMPTY_VEHICLE);
    setVin(null);
    setSource(null);
    setRecalls([]);
    setTsbs([]);
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      console.warn("[vehicleCtx] clear failed:", err);
    }
  }, []);

  // Apply a VIN-decoded vehicle internally (used by the OBD2 auto-VIN path).
  // Preserves the technician's mileage value since the VIN doesn't carry it.
  const applyDecodedFromObd2 = useCallback(
    async (vinValue: string, decoded: VehicleInfo) => {
      const merged: VehicleInfo = {
        ...decoded,
        mileage: vehicleRef.current.mileage ?? "",
      };
      setVehicleState(merged);
      setVin(vinValue);
      setSource("obd2-auto");
      await persist(merged, vinValue, "obd2-auto");
      await refreshMetadata(merged);
    },
    [persist, refreshMetadata],
  );

  // Load persisted vehicle on mount + refresh recalls/TSBs once.
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as PersistedShape;
        if (parsed?.vehicle) {
          setVehicleState({ ...EMPTY_VEHICLE, ...parsed.vehicle });
          setVin(parsed.vin ?? null);
          setSource(parsed.source ?? null);
          if (vehicleHasIdentity(parsed.vehicle)) {
            // Background refresh — don't block UI.
            refreshMetadata(parsed.vehicle).catch(() => {});
          }
        }
      } catch (err) {
        console.warn("[vehicleCtx] hydrate failed:", err);
      }
    })();
  }, [refreshMetadata]);

  // Subscribe to OBD2 status. When the adapter reports "connected", request
  // the VIN. We dedupe so we only attempt VIN retrieval once per "connected"
  // transition (i.e. not on every status event while already connected).
  const lastAttemptedForVin = useRef<string | null>(null);
  useEffect(() => {
    const off = obd2.onStatus(async (status) => {
      if (status !== "connected") {
        if (status === "idle" || status === "error") {
          // Allow a fresh attempt next time we connect.
          lastAttemptedForVin.current = null;
        }
        return;
      }
      // Single-shot per connection.
      if (lastAttemptedForVin.current === "attempted") return;
      lastAttemptedForVin.current = "attempted";

      const detectedVin = await obd2.getVin().catch(() => null);
      if (!detectedVin) return; // Silent fallback per spec.

      // If we already have this exact VIN, nothing to do.
      if (vinRef.current && vinRef.current === detectedVin) return;

      const decoded = await decodeVin(detectedVin).catch(() => null);
      if (!decoded) {
        // VIN read OK but NHTSA decode failed. We only reach here when the VIN
        // differs from what context holds (the equal case returns at the guard
        // above), so the current year/make/model belong to a *different*
        // physical car. The VIN is the source of truth for which vehicle this
        // session is — so blank the stale name rather than carry it forward
        // attached to the new VIN. The session/global label then renders as the
        // bare VIN (honest and obviously incomplete) instead of the previous
        // car's identity. Preserve mileage; refreshMetadata clears the prior
        // car's recalls/TSBs since the blanked vehicle has no identity.
        const vinOnly: VehicleInfo = {
          ...EMPTY_VEHICLE,
          mileage: vehicleRef.current.mileage ?? "",
        };
        setVehicleState(vinOnly);
        setVin(detectedVin);
        setSource("obd2-auto");
        await persist(vinOnly, detectedVin, "obd2-auto");
        await refreshMetadata(vinOnly);
        return;
      }

      const decodedVehicle: VehicleInfo = {
        year: decoded.year,
        make: decoded.make,
        model: decoded.model,
        series: decoded.series,
        trim: decoded.trim,
        engineType: decoded.engineType,
        mileage: vehicleRef.current.mileage ?? "",
      };

      // Conflict resolution. If the tech entered a different vehicle
      // manually before connecting, ask before overwriting.
      const current = vehicleRef.current;
      const manualPresent =
        vehicleHasIdentity(current) && sourceRef.current === "manual";
      const conflict = manualPresent && vehiclesDiffer(current, decodedVehicle);

      if (conflict) {
        Alert.alert(
          "Vehicle mismatch",
          `Connected vehicle (${formatVehicleShort(decodedVehicle)}) differs from entered vehicle (${formatVehicleShort(current)}). Use detected vehicle?`,
          [
            { text: "Keep entered", style: "cancel" },
            {
              text: "Use detected",
              onPress: () => {
                applyDecodedFromObd2(detectedVin, decodedVehicle).catch(() => {});
              },
            },
          ],
        );
        return;
      }

      // No conflict — apply silently. Show the "Vehicle detected" toast only
      // when it's worth surfacing: a USER-initiated connect, or a GENUINE
      // vehicle change (different truck than last time). Suppress it for a SILENT
      // same-vehicle auto-reconnect, which would otherwise pop on every app
      // launch now that reconnect is app-level (SB2-B). (The same-VIN early
      // return above already covers the hydrated case; this also covers the
      // launch race where the persisted VIN hasn't loaded yet.)
      const isSilentReconnect = obd2.wasLastConnectSilent();
      const isGenuineChange =
        vehicleHasIdentity(current) && vehiclesDiffer(current, decodedVehicle);
      await applyDecodedFromObd2(detectedVin, decodedVehicle);
      if (!isSilentReconnect || isGenuineChange) {
        Alert.alert(
          "Vehicle detected",
          formatVehicleShort(decodedVehicle),
          [{ text: "OK" }],
          { cancelable: true },
        );
      }
    });
    return () => {
      off();
    };
  }, [applyDecodedFromObd2, persist]);

  return (
    <VehicleContext.Provider
      value={{
        vehicle,
        vin,
        source,
        recalls,
        tsbs,
        lookupBusy,
        setVehicleManually,
        clearVehicle,
      }}
    >
      {children}
    </VehicleContext.Provider>
  );
}

export function useVehicle(): VehicleState {
  const ctx = useContext(VehicleContext);
  if (!ctx) {
    // Defensive default for screens accidentally rendered outside the
    // provider — they see an empty vehicle rather than crash.
    return {
      vehicle: EMPTY_VEHICLE,
      vin: null,
      source: null,
      recalls: [],
      tsbs: [],
      lookupBusy: false,
      setVehicleManually: async () => {},
      clearVehicle: async () => {},
    };
  }
  return ctx;
}
