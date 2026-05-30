import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Navbar from "../components/Navbar";
import { useObd2 } from "../contexts/Obd2Context";
import { useVehicle } from "../contexts/VehicleContext";
import { fetchDtcDefinition } from "../lib/api";
import { setHandoff } from "../lib/handoff";
import {
  type DiscoveredDevice,
  type FreezeFrame,
  obd2,
} from "../lib/obd2";
import type { SavedAdapter } from "../lib/savedAdapter";
import { HIT_TARGET, colors } from "../lib/theme";
import type { DtcDefinition } from "../lib/types";

type DefinitionState =
  | { state: "loading" }
  | { state: "found"; entry: DtcDefinition }
  | { state: "unknown" }
  | { state: "error"; message: string };

export default function Obd2Screen() {
  const router = useRouter();
  const { status, statusMessage, devices, liveData, isConnected } = useObd2();
  const { vehicle, source: vehicleSource } = useVehicle();
  const vehicleLabel = [vehicle.year, vehicle.make, vehicle.model]
    .filter((s) => s && s.trim().length > 0)
    .join(" ");

  const [pickerOpen, setPickerOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [readingDtcs, setReadingDtcs] = useState(false);
  const [dtcs, setDtcs] = useState<string[]>([]);
  const [pendingDtcs, setPendingDtcs] = useState<string[]>([]);
  const [freezeFrame, setFreezeFrame] = useState<FreezeFrame | null>(null);
  const [clearError, setClearError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [definitions, setDefinitions] = useState<Record<string, DefinitionState>>(
    {},
  );

  // Auto-reconnect state. `savedAdapter` is the adapter we remember from a
  // previous session (null until the load completes, then either the record
  // or undefined for "no saved adapter"). `autoConnecting` is true while the
  // background connect attempt runs. `autoConnectMissed` is set after a
  // failed attempt so the UI can show a "couldn't find your saved adapter"
  // fallback instead of the default first-time-user copy.
  const [savedAdapter, setSavedAdapter] = useState<SavedAdapter | null | undefined>(
    undefined,
  );
  const [autoConnecting, setAutoConnecting] = useState(false);
  const [autoConnectMissed, setAutoConnectMissed] = useState<SavedAdapter | null>(
    null,
  );

  // Whenever new DTCs come back from a scan, kick off a parallel lookup
  // against the backend's curated database. Codes not in the DB (404) are
  // marked "unknown" — the UI shows a fallback line for those rather than
  // hiding them.
  // Race-condition handling: if the tech scans codes before the auto-VIN
  // populates the vehicle, the first batch of definitions will fetch with
  // empty make/engineType. When vehicle.make or vehicle.engineType later
  // changes, clear the definitions cache so the codes re-fetch with the
  // full vehicle context (manufacturer-specific lookup + config-mismatch
  // detection).
  useEffect(() => {
    setDefinitions({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicle.make, vehicle.engineType]);

  useEffect(() => {
    const all = [...dtcs, ...pendingDtcs];
    const toFetch = all.filter((code) => !definitions[code]);
    if (toFetch.length === 0) return;

    setDefinitions((prev) => {
      const next = { ...prev };
      for (const code of toFetch) {
        if (!next[code]) next[code] = { state: "loading" };
      }
      return next;
    });

    let cancelled = false;
    for (const code of toFetch) {
      fetchDtcDefinition(code, vehicle.make, vehicle.engineType)
        .then((entry) => {
          if (cancelled) return;
          setDefinitions((prev) => ({
            ...prev,
            [code]: entry ? { state: "found", entry } : { state: "unknown" },
          }));
        })
        .catch((err) => {
          if (cancelled) return;
          setDefinitions((prev) => ({
            ...prev,
            [code]: {
              state: "error",
              message: err instanceof Error ? err.message : "Lookup failed.",
            },
          }));
        });
    }
    return () => {
      cancelled = true;
    };
    // We intentionally depend on the array contents via length+join to avoid
    // re-fetching every render. The `definitions` cache is keyed by code so
    // already-fetched codes are no-ops. Vehicle make / engineType changes
    // are handled separately by the cache-clearing effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dtcs.join(","), pendingDtcs.join(",")]);

  // Auto-start live data polling when the connection comes up.
  useEffect(() => {
    if (isConnected && !obd2.isPolling()) {
      obd2.startPolling(250);
      setPaused(false);
    }
    if (!isConnected) {
      obd2.stopPolling();
      setDtcs([]);
      setPendingDtcs([]);
      setFreezeFrame(null);
      setDefinitions({});
    }
  }, [isConnected]);

  // On first mount, look up the remembered adapter and try to reconnect to
  // it silently. If it works, the user is straight in the connected state
  // with no scanning. If it doesn't, fall back to the manual picker with a
  // friendly "couldn't find it" message.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await obd2.loadSavedAdapter();
      if (cancelled) return;
      setSavedAdapter(saved ?? null);
      if (!saved) return;
      if (obd2.isConnected()) return;
      setAutoConnecting(true);
      const result = await obd2.connectDirect(saved);
      if (cancelled) return;
      setAutoConnecting(false);
      if (!result.ok) {
        setAutoConnectMissed(saved);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onScanForAdapters() {
    obd2.clearDiscovered();
    setScanning(true);
    setPickerOpen(true);
    try {
      await obd2.startScan(20000);
    } finally {
      setScanning(false);
    }
  }

  async function onScanAgain() {
    obd2.clearDiscovered();
    setScanning(true);
    try {
      await obd2.startScan(20000);
    } finally {
      setScanning(false);
    }
  }

  async function onSelectDevice(device: DiscoveredDevice) {
    setConnecting(device.id);
    try {
      const result = await obd2.connect(device.id);
      if (result.ok) {
        setPickerOpen(false);
        setAutoConnectMissed(null);
        // The library saves the adapter on successful handshake; reflect it
        // locally so the "Change adapter" link shows up immediately.
        setSavedAdapter({
          deviceId: device.id,
          name: device.name,
          transport: device.transport,
          lastConnectedAt: Date.now(),
        });
      } else {
        Alert.alert("Couldn't connect", result.message);
      }
    } finally {
      setConnecting(null);
    }
  }

  async function onDisconnect() {
    await obd2.disconnect();
  }

  async function onChangeAdapter() {
    await obd2.disconnect();
    await obd2.forgetSavedAdapter();
    setSavedAdapter(null);
    setAutoConnectMissed(null);
    onScanForAdapters();
  }

  async function onScanDtcs() {
    setReadingDtcs(true);
    try {
      const result = await obd2.scanDtcs();
      setDtcs(result.dtcs);
      setPendingDtcs(result.pending);
      setFreezeFrame(result.freezeFrame);
    } finally {
      setReadingDtcs(false);
    }
  }

  function onClearDtcs() {
    Alert.alert(
      "Clear all codes?",
      "This resets stored fault codes and freeze frame data. Confirmed faults will reappear if they re-occur.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: async () => {
            const res = await obd2.clearDtcs();
            if (!res.ok) {
              setClearError(res.message);
              return;
            }
            setDtcs([]);
            setPendingDtcs([]);
            setFreezeFrame(null);
            setDefinitions({});
            setClearError(null);
          },
        },
      ],
    );
  }

  function togglePolling() {
    if (paused) {
      obd2.resumePolling();
      setPaused(false);
    } else {
      obd2.pausePolling();
      setPaused(true);
    }
  }

  async function onDiagnoseWithVulcan() {
    if (dtcs.length === 0) {
      Alert.alert(
        "No codes to send",
        "Run a code scan first, then we can hand the results to Vulcan.",
      );
      return;
    }
    await setHandoff({
      type: "to_diagnose",
      symptom: "",
      dtcs,
    });
    router.replace("/diagnose");
  }

  const visibleObd = devices.filter((d) => d.likelyObd);
  const visibleOther = devices.filter((d) => !d.likelyObd);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <Navbar showBack />

      {vehicleLabel ? (
        <View style={styles.vehicleBanner}>
          <Ionicons name="car-outline" size={14} color={colors.accent} />
          <Text style={styles.vehicleBannerText} numberOfLines={1}>
            {vehicleLabel}
          </Text>
          {vehicleSource === "obd2-auto" ? (
            <View style={styles.vehicleBadge}>
              <Text style={styles.vehicleBadgeText}>AUTO</Text>
            </View>
          ) : null}
        </View>
      ) : null}

      <StatusBar status={status} message={statusMessage} />

      <ScrollView contentContainerStyle={styles.content}>
        {/* ---------------- Connect section ---------------- */}
        <Section title="CONNECT">
          {isConnected ? (
            <>
              <View style={styles.connectedRow}>
                <Ionicons
                  name="checkmark-circle"
                  size={22}
                  color={colors.okText}
                />
                <Text style={styles.connectedText}>
                  {statusMessage || "Connected to adapter"}
                </Text>
                <TouchableOpacity
                  style={styles.secondaryBtn}
                  onPress={onDisconnect}
                  activeOpacity={0.85}
                >
                  <Text style={styles.secondaryBtnText}>Disconnect</Text>
                </TouchableOpacity>
              </View>
              {savedAdapter ? (
                <TouchableOpacity
                  onPress={onChangeAdapter}
                  activeOpacity={0.7}
                  style={styles.changeAdapterRow}
                >
                  <Ionicons
                    name="swap-horizontal"
                    size={14}
                    color={colors.accent}
                  />
                  <Text style={styles.changeAdapterText}>Change adapter</Text>
                </TouchableOpacity>
              ) : null}
            </>
          ) : autoConnecting && savedAdapter ? (
            <View style={styles.autoConnectRow}>
              <ActivityIndicator size="small" color={colors.accent} />
              <Text style={styles.bodyText}>
                Connecting to {savedAdapter.name}…
              </Text>
            </View>
          ) : autoConnectMissed ? (
            <>
              <Text style={styles.bodyText}>
                Couldn't find your saved adapter ({autoConnectMissed.name}).
                Make sure it's plugged in and powered on, then scan for
                devices.
              </Text>
              <TouchableOpacity
                style={styles.primaryBtn}
                onPress={onScanForAdapters}
                disabled={status === "connecting"}
                activeOpacity={0.85}
              >
                {status === "scanning" ? (
                  <View style={styles.btnLoadingRow}>
                    <ActivityIndicator size="small" color="#FFFFFF" />
                    <Text style={styles.primaryBtnText}>Scanning…</Text>
                  </View>
                ) : (
                  <Text style={styles.primaryBtnText}>Scan for devices</Text>
                )}
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={styles.bodyText}>
                Plug your ELM327 adapter into the OBD2 port, turn the key to
                run, and tap below to find it over Bluetooth.
              </Text>
              <TouchableOpacity
                style={[
                  styles.primaryBtn,
                  status === "connecting" && styles.btnDisabled,
                ]}
                onPress={onScanForAdapters}
                disabled={status === "connecting"}
                activeOpacity={0.85}
              >
                {status === "scanning" ? (
                  <View style={styles.btnLoadingRow}>
                    <ActivityIndicator size="small" color="#FFFFFF" />
                    <Text style={styles.primaryBtnText}>Scanning…</Text>
                  </View>
                ) : (
                  <Text style={styles.primaryBtnText}>Connect to vehicle</Text>
                )}
              </TouchableOpacity>
              {status === "error" && statusMessage ? (
                <View style={styles.errorBox}>
                  <Text style={styles.errorText}>{statusMessage}</Text>
                  {/Bluetooth is off/i.test(statusMessage) && (
                    <TouchableOpacity
                      onPress={() => Linking.openSettings()}
                      activeOpacity={0.7}
                      style={styles.linkBtn}
                    >
                      <Text style={styles.linkBtnText}>Open Settings</Text>
                    </TouchableOpacity>
                  )}
                </View>
              ) : null}
            </>
          )}
        </Section>

        {/* ---------------- Scan section ---------------- */}
        <Section title="SCAN">
          {!isConnected ? (
            <Text style={styles.dimText}>Connect an adapter to scan codes.</Text>
          ) : (
            <>
              <View style={styles.btnRow}>
                <TouchableOpacity
                  style={[styles.primaryBtn, styles.btnHalf]}
                  onPress={onScanDtcs}
                  disabled={readingDtcs}
                  activeOpacity={0.85}
                >
                  {readingDtcs ? (
                    <View style={styles.btnLoadingRow}>
                      <ActivityIndicator size="small" color="#FFFFFF" />
                      <Text style={styles.primaryBtnText}>Reading…</Text>
                    </View>
                  ) : (
                    <Text style={styles.primaryBtnText}>Scan for codes</Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.dangerBtn,
                    styles.btnHalf,
                    (dtcs.length === 0 || readingDtcs) && styles.btnDisabled,
                  ]}
                  onPress={onClearDtcs}
                  disabled={dtcs.length === 0 || readingDtcs}
                  activeOpacity={0.85}
                >
                  <Text style={styles.dangerBtnText}>Clear codes</Text>
                </TouchableOpacity>
              </View>

              {clearError ? (
                <View style={styles.errorBox}>
                  <Text style={styles.errorText}>{clearError}</Text>
                </View>
              ) : null}

              {dtcs.length === 0 && pendingDtcs.length === 0 && !readingDtcs ? (
                <Text style={styles.dimText}>
                  No codes read yet. Tap "Scan for codes" to query the ECU.
                </Text>
              ) : null}

              {dtcs.length > 0 && (
                <View style={styles.dtcGroup}>
                  <Text style={styles.dtcGroupLabel}>
                    STORED CODES · {dtcs.length}
                  </Text>
                  {dtcs.map((code) => (
                    <DtcCard
                      key={code}
                      code={code}
                      kind="stored"
                      definition={definitions[code]}
                    />
                  ))}
                </View>
              )}
              {pendingDtcs.length > 0 && (
                <View style={styles.dtcGroup}>
                  <Text style={styles.dtcGroupLabel}>
                    PENDING · {pendingDtcs.length}
                  </Text>
                  {pendingDtcs.map((code) => (
                    <DtcCard
                      key={code}
                      code={code}
                      kind="pending"
                      definition={definitions[code]}
                    />
                  ))}
                </View>
              )}

              {freezeFrame && (freezeFrame.dtc || freezeFrame.rpm) ? (
                <View style={styles.freezeBox}>
                  <Text style={styles.freezeLabel}>FREEZE FRAME</Text>
                  {freezeFrame.dtc ? (
                    <Text style={styles.freezeMain}>
                      Captured at {freezeFrame.dtc}
                    </Text>
                  ) : null}
                  <View style={styles.freezeGrid}>
                    {freezeFrame.rpm != null && (
                      <FreezeCell
                        label="RPM"
                        value={`${Math.round(freezeFrame.rpm)}`}
                      />
                    )}
                    {freezeFrame.speedKph != null && (
                      <FreezeCell
                        label="Speed"
                        value={`${freezeFrame.speedKph} km/h`}
                      />
                    )}
                    {freezeFrame.coolantC != null && (
                      <FreezeCell
                        label="Coolant"
                        value={`${freezeFrame.coolantC} °C`}
                      />
                    )}
                    {freezeFrame.fuelPressure != null && (
                      <FreezeCell
                        label="Fuel P."
                        value={`${freezeFrame.fuelPressure} kPa`}
                      />
                    )}
                  </View>
                </View>
              ) : null}

              {dtcs.length > 0 && (
                <TouchableOpacity
                  style={styles.diagnoseBtn}
                  onPress={onDiagnoseWithVulcan}
                  activeOpacity={0.85}
                >
                  <Ionicons name="flash" size={18} color="#FFFFFF" />
                  <Text style={styles.diagnoseBtnText}>
                    Diagnose with Vulcan
                  </Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </Section>

        {/* ---------------- Live data section ---------------- */}
        <Section title="LIVE DATA">
          {!isConnected ? (
            <Text style={styles.dimText}>
              Connect an adapter to see live sensor readings.
            </Text>
          ) : (
            <>
              <View style={styles.liveHeader}>
                <Text style={styles.dimText}>
                  Polling each PID round-robin. Values refresh every ~2 s.
                </Text>
                <TouchableOpacity
                  style={styles.pauseBtn}
                  onPress={togglePolling}
                  activeOpacity={0.85}
                >
                  <Ionicons
                    name={paused ? "play" : "pause"}
                    size={16}
                    color={colors.accent}
                  />
                  <Text style={styles.pauseBtnText}>
                    {paused ? "Resume" : "Pause"}
                  </Text>
                </TouchableOpacity>
              </View>
              <View style={styles.gauges}>
                <Gauge
                  label="RPM"
                  value={liveData.rpm != null ? Math.round(liveData.rpm) : null}
                  unit=""
                />
                <Gauge
                  label="Speed"
                  value={liveData.speedKph}
                  unit="km/h"
                />
                <Gauge
                  label="Coolant"
                  value={liveData.coolantC}
                  unit="°C"
                />
                <Gauge
                  label="Intake air"
                  value={liveData.intakeAirC}
                  unit="°C"
                />
                <Gauge
                  label="MAF"
                  value={
                    liveData.mafGps != null
                      ? Number(liveData.mafGps.toFixed(1))
                      : null
                  }
                  unit="g/s"
                />
                <Gauge
                  label="Throttle"
                  value={
                    liveData.throttlePct != null
                      ? Number(liveData.throttlePct.toFixed(0))
                      : null
                  }
                  unit="%"
                />
                <Gauge
                  label="STFT"
                  value={
                    liveData.shortFuelTrimPct != null
                      ? Number(liveData.shortFuelTrimPct.toFixed(1))
                      : null
                  }
                  unit="%"
                  signed
                />
                <Gauge
                  label="LTFT"
                  value={
                    liveData.longFuelTrimPct != null
                      ? Number(liveData.longFuelTrimPct.toFixed(1))
                      : null
                  }
                  unit="%"
                  signed
                />
                <Gauge
                  label="Battery"
                  value={
                    liveData.batteryV != null
                      ? Number(liveData.batteryV.toFixed(2))
                      : null
                  }
                  unit="V"
                />
              </View>
            </>
          )}
        </Section>
      </ScrollView>

      <DevicePicker
        visible={pickerOpen}
        scanning={scanning}
        connecting={connecting}
        obdDevices={visibleObd}
        otherDevices={visibleOther}
        onSelect={onSelectDevice}
        onScanAgain={onScanAgain}
        onClose={() => {
          setPickerOpen(false);
          obd2.stopScan();
        }}
      />
    </SafeAreaView>
  );
}

// ---------- Status bar ----------

function StatusBar({
  status,
  message,
}: {
  status: ReturnType<typeof useObd2>["status"];
  message: string;
}) {
  const palette =
    status === "connected"
      ? { bg: colors.okBg, border: colors.okBorder, text: colors.okText, dot: colors.okText }
      : status === "connecting" || status === "scanning" || status === "handshaking"
        ? {
            bg: colors.warnBg,
            border: colors.warnBorder,
            text: colors.warnText,
            dot: colors.warnText,
          }
        : status === "error"
          ? {
              bg: colors.dangerBg,
              border: colors.dangerBorder,
              text: colors.dangerText,
              dot: colors.dangerText,
            }
          : {
              bg: colors.surface,
              border: colors.border,
              text: colors.muted,
              dot: colors.muted,
            };

  const label =
    status === "connected"
      ? "Connected"
      : status === "connecting"
        ? "Connecting…"
        : status === "scanning"
          ? "Scanning Bluetooth…"
          : status === "handshaking"
            ? "Handshaking…"
            : status === "error"
              ? "Error"
              : "Disconnected";

  return (
    <View
      style={[
        styles.statusBar,
        { backgroundColor: palette.bg, borderBottomColor: palette.border },
      ]}
    >
      <View style={[styles.statusDot, { backgroundColor: palette.dot }]} />
      <Text style={[styles.statusLabel, { color: palette.text }]}>{label}</Text>
      {message ? (
        <Text style={[styles.statusMessage, { color: palette.text }]} numberOfLines={1}>
          {" — "}
          {message}
        </Text>
      ) : null}
    </View>
  );
}

// ---------- Section wrapper ----------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionCard}>{children}</View>
    </View>
  );
}

// ---------- Live data gauge ----------

function Gauge({
  label,
  value,
  unit,
  signed,
}: {
  label: string;
  value: number | null;
  unit: string;
  signed?: boolean;
}) {
  const display =
    value == null
      ? "—"
      : signed && value > 0
        ? `+${value}`
        : String(value);
  return (
    <View style={styles.gauge}>
      <Text style={styles.gaugeLabel}>{label}</Text>
      <View style={styles.gaugeValueRow}>
        <Text style={styles.gaugeValue}>{display}</Text>
        {unit ? <Text style={styles.gaugeUnit}>{unit}</Text> : null}
      </View>
    </View>
  );
}

// ---------- DTC card with inline definition ----------

function DtcCard({
  code,
  kind,
  definition,
}: {
  code: string;
  kind: "stored" | "pending";
  definition: DefinitionState | undefined;
}) {
  const [expanded, setExpanded] = useState(false);

  const palette =
    kind === "stored"
      ? {
          bg: colors.dangerBg,
          border: colors.dangerBorder,
          text: colors.dangerText,
        }
      : {
          bg: colors.warnBg,
          border: colors.warnBorder,
          text: colors.warnText,
        };

  const urgencyChip = (() => {
    if (definition?.state !== "found") return null;
    const u = definition.entry.urgency;
    const p =
      u === "high"
        ? { bg: colors.dangerBg, text: colors.dangerText }
        : u === "medium"
          ? { bg: colors.warnBg, text: colors.warnText }
          : { bg: colors.okBg, text: colors.okText };
    return (
      <View style={[styles.urgencyChip, { backgroundColor: p.bg }]}>
        <Text style={[styles.urgencyChipText, { color: p.text }]}>
          {u.toUpperCase()}
        </Text>
      </View>
    );
  })();

  return (
    <TouchableOpacity
      style={[
        styles.dtcCard,
        { backgroundColor: palette.bg, borderColor: palette.border },
      ]}
      onPress={() => setExpanded((e) => !e)}
      activeOpacity={0.85}
      disabled={definition?.state !== "found"}
      accessibilityRole="button"
      accessibilityLabel={`${code} ${definition?.state === "found" ? definition.entry.shortDescription : ""}`}
    >
      <View style={styles.dtcHeader}>
        <Text style={[styles.dtcCode, { color: palette.text }]}>{code}</Text>
        {urgencyChip}
        {definition?.state === "found" ? (
          <Text style={[styles.dtcChevron, { color: palette.text }]}>
            {expanded ? "▾" : "▸"}
          </Text>
        ) : null}
      </View>

      {!definition || definition.state === "loading" ? (
        <View style={styles.dtcInlineRow}>
          <ActivityIndicator size="small" color={palette.text} />
          <Text style={[styles.dtcInlineDim, { color: palette.text }]}>
            Looking up definition…
          </Text>
        </View>
      ) : null}

      {definition?.state === "found" ? (
        <>
          {definition.entry.configMismatch ? (
            <View style={styles.mismatchBanner}>
              <Ionicons
                name="warning-outline"
                size={14}
                color={colors.warnText}
              />
              <Text style={styles.mismatchText}>
                {definition.entry.configMismatch.message}
              </Text>
            </View>
          ) : null}
          <Text style={[styles.dtcShort, { color: colors.heading }]}>
            {definition.entry.shortDescription}
          </Text>
          <Text style={styles.dtcSystem}>
            System: {definition.entry.system}
          </Text>
          {expanded && (
            <View style={styles.dtcExpanded}>
              <Text style={styles.dtcDetailed}>
                {definition.entry.detailedDescription}
              </Text>
              <Text style={styles.dtcCausesLabel}>COMMON CAUSES</Text>
              {definition.entry.commonCauses.map((cause, i) => (
                <View key={i} style={styles.dtcCauseRow}>
                  <Text style={styles.dtcCauseBullet}>•</Text>
                  <Text style={styles.dtcCauseText}>{cause}</Text>
                </View>
              ))}
            </View>
          )}
        </>
      ) : null}

      {definition?.state === "unknown" ? (
        <Text style={styles.dtcInlineDim}>
          No definition in our database. Use "Diagnose with Vulcan" below for
          an interpretation.
        </Text>
      ) : null}

      {definition?.state === "error" ? (
        <Text style={[styles.dtcInlineDim, { color: colors.dangerText }]}>
          Couldn't load definition — {definition.message}
        </Text>
      ) : null}
    </TouchableOpacity>
  );
}

// ---------- Freeze frame cell ----------

function FreezeCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.freezeCell}>
      <Text style={styles.freezeCellLabel}>{label}</Text>
      <Text style={styles.freezeCellValue}>{value}</Text>
    </View>
  );
}

// ---------- Device picker modal ----------

type PickerRow =
  | { kind: "obd-header" }
  | { kind: "other-header" }
  | { kind: "other-note" }
  | { kind: "device"; device: DiscoveredDevice };

function DevicePicker({
  visible,
  scanning,
  connecting,
  obdDevices,
  otherDevices,
  onSelect,
  onScanAgain,
  onClose,
}: {
  visible: boolean;
  scanning: boolean;
  connecting: string | null;
  obdDevices: DiscoveredDevice[];
  otherDevices: DiscoveredDevice[];
  onSelect: (d: DiscoveredDevice) => void;
  onScanAgain: () => void;
  onClose: () => void;
}) {
  const rows: PickerRow[] = [
    ...(obdDevices.length > 0 ? [{ kind: "obd-header" as const }] : []),
    ...obdDevices.map((d) => ({ kind: "device" as const, device: d })),
    ...(otherDevices.length > 0
      ? [
          { kind: "other-header" as const },
          { kind: "other-note" as const },
        ]
      : []),
    ...otherDevices.map((d) => ({ kind: "device" as const, device: d })),
  ];

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.modalSafe} edges={["top", "bottom"]}>
        <View style={styles.modalTopBar}>
          <TouchableOpacity
            onPress={onClose}
            style={styles.modalCloseBtn}
            activeOpacity={0.7}
          >
            <Text style={styles.modalCloseText}>Cancel</Text>
          </TouchableOpacity>
          <Text style={styles.modalTitle}>Bluetooth devices</Text>
          <View style={styles.modalCloseBtn} />
        </View>

        <FlatList
          data={rows}
          keyExtractor={(item, i) => {
            if (item.kind === "device") return `d-${item.device.id}-${i}`;
            return `h-${item.kind}`;
          }}
          ListHeaderComponent={
            scanning ? (
              <View style={styles.scanRow}>
                <ActivityIndicator size="small" color={colors.accent} />
                <Text style={styles.scanRowText}>
                  Scanning Bluetooth for up to 20 seconds…
                </Text>
              </View>
            ) : null
          }
          ListEmptyComponent={
            !scanning ? (
              <View style={styles.emptyWrap}>
                <Text style={styles.dimText}>
                  No devices found. Make sure the adapter is powered (plugged
                  into the OBD2 port with the key on), and try again.
                </Text>
                {Platform.OS === "android" && (
                  <Text style={[styles.dimText, styles.emptyHint]}>
                    Bluetooth Classic adapters (like the OBDLink MX+) must be
                    paired in Android Bluetooth Settings first. Pair the
                    adapter there (PIN is typically 1234 or 0000), then tap
                    Scan Again.
                  </Text>
                )}
              </View>
            ) : null
          }
          ListFooterComponent={
            <View style={styles.scanAgainWrap}>
              <TouchableOpacity
                style={[
                  styles.scanAgainBtn,
                  scanning && styles.btnDisabled,
                ]}
                onPress={onScanAgain}
                disabled={scanning}
                activeOpacity={0.85}
              >
                {scanning ? (
                  <View style={styles.btnLoadingRow}>
                    <ActivityIndicator size="small" color={colors.accent} />
                    <Text style={styles.scanAgainText}>Scanning…</Text>
                  </View>
                ) : (
                  <>
                    <Ionicons
                      name="refresh"
                      size={16}
                      color={colors.accent}
                    />
                    <Text style={styles.scanAgainText}>Scan again</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          }
          renderItem={({ item }) => {
            if (item.kind === "obd-header") {
              return (
                <View style={styles.sectionHeaderRow}>
                  <Ionicons
                    name="construct"
                    size={14}
                    color={colors.accent}
                  />
                  <Text style={styles.sectionHeaderText}>OBD2 ADAPTERS</Text>
                </View>
              );
            }
            if (item.kind === "other-header") {
              return (
                <View style={styles.sectionHeaderRow}>
                  <Ionicons
                    name="bluetooth"
                    size={14}
                    color={colors.muted}
                  />
                  <Text
                    style={[
                      styles.sectionHeaderText,
                      { color: colors.muted },
                    ]}
                  >
                    OTHER BLUETOOTH DEVICES
                  </Text>
                </View>
              );
            }
            if (item.kind === "other-note") {
              return (
                <Text style={styles.sectionHeaderNote}>
                  Not sure? Select your OBD2 adapter from this list if it
                  doesn't appear above.
                </Text>
              );
            }
            return (
              <TouchableOpacity
                style={styles.deviceRow}
                onPress={() => onSelect(item.device)}
                disabled={!!connecting}
                activeOpacity={0.7}
              >
                <SignalBars rssi={item.device.rssi} />
                <View style={{ flex: 1 }}>
                  <View style={styles.deviceNameRow}>
                    <Text style={styles.deviceName}>{item.device.name}</Text>
                    <View
                      style={[
                        styles.transportChip,
                        item.device.transport === "classic"
                          ? styles.transportClassic
                          : styles.transportBle,
                      ]}
                    >
                      <Text
                        style={[
                          styles.transportChipText,
                          {
                            color:
                              item.device.transport === "classic"
                                ? colors.warnText
                                : colors.accent,
                          },
                        ]}
                      >
                        {item.device.transport === "classic"
                          ? "CLASSIC"
                          : "BLE"}
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.deviceMeta}>
                    {item.device.transport === "classic"
                      ? "Paired adapter"
                      : signalLabel(item.device.rssi)}
                    {item.device.rssi != null
                      ? `  ·  ${item.device.rssi} dBm`
                      : ""}
                  </Text>
                </View>
                {connecting === item.device.id ? (
                  <ActivityIndicator size="small" color={colors.accent} />
                ) : (
                  <Text style={styles.deviceChev}>›</Text>
                )}
              </TouchableOpacity>
            );
          }}
          contentContainerStyle={{ paddingBottom: 16 }}
        />
      </SafeAreaView>
    </Modal>
  );
}

function SignalBars({ rssi }: { rssi: number | null }) {
  const strength = rssi == null ? 0 : rssi >= -60 ? 3 : rssi >= -75 ? 2 : 1;
  return (
    <View style={styles.signalCol}>
      <View
        style={[styles.signalBar, styles.signalBar3, strength >= 3 && styles.signalActive]}
      />
      <View
        style={[styles.signalBar, styles.signalBar2, strength >= 2 && styles.signalActive]}
      />
      <View
        style={[styles.signalBar, styles.signalBar1, strength >= 1 && styles.signalActive]}
      />
    </View>
  );
}

function signalLabel(rssi: number | null): string {
  if (rssi == null) return "Unknown signal";
  if (rssi >= -60) return "Strong signal";
  if (rssi >= -75) return "Medium signal";
  return "Weak signal";
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  vehicleBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 6,
    backgroundColor: colors.accentFade,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  vehicleBannerText: {
    color: colors.heading,
    fontSize: 12,
    fontWeight: "600",
    flex: 1,
  },
  vehicleBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
    backgroundColor: colors.accent,
  },
  vehicleBadgeText: {
    color: "#FFFFFF",
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1,
  },
  statusBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusLabel: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.4,
  },
  statusMessage: {
    fontSize: 12,
    flex: 1,
  },
  content: {
    padding: 16,
    paddingBottom: 48,
    gap: 18,
  },
  section: {
    gap: 8,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.8,
    color: colors.accent,
    paddingLeft: 2,
  },
  sectionCard: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 14,
    gap: 12,
  },
  bodyText: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 21,
  },
  dimText: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19,
  },
  primaryBtn: {
    minHeight: HIT_TARGET,
    paddingHorizontal: 16,
    backgroundColor: colors.accent,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  btnLoadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  btnDisabled: {
    opacity: 0.45,
  },
  dangerBtn: {
    minHeight: HIT_TARGET,
    paddingHorizontal: 16,
    backgroundColor: colors.dangerFill,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  dangerBtnText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "600",
  },
  secondaryBtn: {
    minHeight: HIT_TARGET - 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryBtnText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "600",
  },
  btnRow: {
    flexDirection: "row",
    gap: 10,
  },
  btnHalf: {
    flex: 1,
  },
  connectedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  connectedText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
    flex: 1,
  },
  changeAdapterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    paddingVertical: 4,
  },
  changeAdapterText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "600",
  },
  autoConnectRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 4,
  },
  errorBox: {
    backgroundColor: colors.dangerBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.dangerBorder,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  errorText: {
    color: colors.dangerText,
    fontSize: 13,
  },
  linkBtn: {
    alignSelf: "flex-start",
  },
  linkBtnText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "600",
  },
  // DTC
  dtcGroup: {
    gap: 6,
  },
  dtcGroupLabel: {
    color: colors.muted,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.5,
  },
  dtcCard: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 6,
  },
  dtcHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  dtcCode: {
    fontSize: 15,
    fontWeight: "700",
    fontFamily: "Menlo",
    letterSpacing: 0.5,
  },
  dtcChevron: {
    marginLeft: "auto",
    fontSize: 16,
    fontWeight: "600",
  },
  urgencyChip: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  mismatchBanner: {
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: colors.warnBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.warnBorder,
    borderRadius: 6,
    marginTop: 2,
  },
  mismatchText: {
    flex: 1,
    color: colors.warnText,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "500",
  },
  urgencyChipText: {
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.2,
  },
  dtcShort: {
    fontSize: 14,
    fontWeight: "600",
    lineHeight: 19,
  },
  dtcSystem: {
    fontSize: 11,
    color: colors.muted,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  dtcInlineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  dtcInlineDim: {
    fontSize: 12,
    fontStyle: "italic",
    flex: 1,
  },
  dtcExpanded: {
    marginTop: 8,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(0,0,0,0.08)",
    gap: 8,
  },
  dtcDetailed: {
    color: colors.text,
    fontSize: 13,
    lineHeight: 19,
  },
  dtcCausesLabel: {
    color: colors.muted,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.5,
    marginTop: 2,
  },
  dtcCauseRow: {
    flexDirection: "row",
    gap: 8,
  },
  dtcCauseBullet: {
    color: colors.text,
    fontSize: 13,
    marginTop: -1,
  },
  dtcCauseText: {
    flex: 1,
    color: colors.text,
    fontSize: 13,
    lineHeight: 19,
  },
  // Freeze frame
  freezeBox: {
    padding: 12,
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    gap: 8,
  },
  freezeLabel: {
    color: colors.muted,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.5,
  },
  freezeMain: {
    color: colors.heading,
    fontSize: 14,
    fontWeight: "600",
  },
  freezeGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  freezeCell: {
    minWidth: "30%",
  },
  freezeCellLabel: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  freezeCellValue: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  // Diagnose handoff button
  diagnoseBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: HIT_TARGET,
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingHorizontal: 16,
  },
  diagnoseBtnText: {
    color: "#FFFFFF",
    fontWeight: "700",
    fontSize: 15,
    letterSpacing: 0.3,
  },
  // Live data
  liveHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  pauseBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: HIT_TARGET - 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent,
    backgroundColor: colors.accentFade,
  },
  pauseBtnText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "600",
  },
  gauges: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  gauge: {
    width: "31%",
    minWidth: 100,
    flexGrow: 1,
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
    gap: 4,
  },
  gaugeLabel: {
    color: colors.muted,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  gaugeValueRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 4,
  },
  gaugeValue: {
    color: colors.heading,
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: -0.4,
    fontFamily: "Menlo",
  },
  gaugeUnit: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "500",
  },
  // Modal device picker
  modalSafe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  modalTopBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  modalCloseBtn: {
    minWidth: HIT_TARGET + 16,
    minHeight: HIT_TARGET,
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  modalCloseText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: "600",
  },
  modalTitle: {
    color: colors.heading,
    fontSize: 16,
    fontWeight: "600",
  },
  scanRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 16,
  },
  scanRowText: {
    color: colors.muted,
    fontSize: 13,
  },
  emptyWrap: {
    padding: 24,
    gap: 12,
  },
  emptyHint: {
    fontSize: 12,
    lineHeight: 18,
    fontStyle: "italic",
  },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 4,
  },
  sectionHeaderText: {
    color: colors.accent,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.5,
  },
  sectionHeaderNote: {
    color: colors.muted,
    fontSize: 12,
    paddingHorizontal: 20,
    paddingBottom: 6,
    lineHeight: 17,
    fontStyle: "italic",
  },
  signalCol: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 2,
    width: 20,
    height: 18,
    justifyContent: "center",
  },
  signalBar: {
    width: 4,
    backgroundColor: colors.border,
    borderRadius: 1,
  },
  signalBar1: {
    height: 6,
  },
  signalBar2: {
    height: 11,
  },
  signalBar3: {
    height: 16,
  },
  signalActive: {
    backgroundColor: colors.accent,
  },
  scanAgainWrap: {
    paddingHorizontal: 20,
    paddingVertical: 18,
    paddingBottom: 32,
  },
  scanAgainBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: HIT_TARGET,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent,
    backgroundColor: colors.accentFade,
  },
  scanAgainText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  deviceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 14,
    minHeight: HIT_TARGET,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  deviceName: {
    color: colors.heading,
    fontSize: 15,
    fontWeight: "600",
  },
  deviceNameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  transportChip: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  transportChipText: {
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.2,
  },
  transportBle: {
    backgroundColor: colors.accentFade,
    borderColor: colors.accent,
  },
  transportClassic: {
    backgroundColor: colors.warnBg,
    borderColor: colors.warnBorder,
  },
  deviceMeta: {
    color: colors.muted,
    fontSize: 11,
    marginTop: 2,
    fontFamily: "Menlo",
  },
  deviceChev: {
    color: colors.muted,
    fontSize: 24,
    fontWeight: "300",
  },
});
