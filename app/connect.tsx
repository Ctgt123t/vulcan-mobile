import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Navbar from "../components/Navbar";
import { useObd2 } from "../contexts/Obd2Context";
import { type DiscoveredDevice, obd2 } from "../lib/obd2";
import type { SavedAdapter } from "../lib/savedAdapter";
import { HIT_TARGET, colors } from "../lib/theme";

// Connect-a-Device — a THIN surface over the obd2 singleton + Obd2Context. It
// renders existing connection state (status / connectedVin / saved adapter) and
// wires the existing actions: scan + connect (obd2.startScan / obd2.connect),
// reconnect (obd2.ensureAutoReconnect), and forget (obd2.forgetSavedAdapter).
// It owns NO BLE, permission, persistence, or auto-reconnect logic — all of that
// already lives in the singleton; this screen only calls into it. The full OBD2
// screen (with live gauges, PID picker, DTC reads) remains at /obd2; this is the
// focused "get me paired" entry point that nudges route here.
export default function ConnectScreen() {
  const router = useRouter();
  const { status, statusMessage, devices, isConnected, connectedVin } =
    useObd2();
  const [scanning, setScanning] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [savedAdapter, setSavedAdapter] = useState<SavedAdapter | null>(null);

  // Reflect the remembered adapter (singleton owns the storage; we only read it
  // to show "Reconnect" / "Forget").
  useEffect(() => {
    let cancelled = false;
    obd2
      .loadSavedAdapter()
      .then((s) => {
        if (!cancelled) setSavedAdapter(s ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isConnected]);

  async function onScan() {
    setScanning(true);
    try {
      await obd2.startScan(20000); // singleton handles permissions + BT state
    } finally {
      setScanning(false);
    }
  }

  async function onSelectDevice(device: DiscoveredDevice) {
    setConnecting(device.id);
    try {
      const result = await obd2.connect(device.id); // singleton saves on success
      if (!result.ok) {
        Alert.alert("Couldn't connect", result.message);
      }
    } finally {
      setConnecting(null);
    }
  }

  async function onReconnect() {
    setReconnecting(true);
    try {
      await obd2.ensureAutoReconnect();
    } finally {
      setReconnecting(false);
    }
  }

  async function onForget() {
    await obd2.disconnect();
    await obd2.forgetSavedAdapter();
    setSavedAdapter(null);
  }

  const visibleObd = devices.filter((d) => d.likelyObd);
  const visibleOther = devices.filter((d) => !d.likelyObd);
  const busy = scanning || status === "scanning";

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <Navbar />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.h1}>Connect a Device</Text>
        <Text style={styles.subtitle}>
          Pair your OBD2 adapter so Vulcan can read live data and trouble codes.
        </Text>

        {/* Status — straight from the shared context (single source of truth). */}
        <View style={styles.statusCard}>
          <View
            style={[
              styles.statusDot,
              isConnected ? styles.dotConnected : styles.dotIdle,
            ]}
          />
          <View style={styles.statusBody}>
            <Text style={styles.statusTitle}>
              {isConnected ? "Connected" : "Not connected"}
            </Text>
            <Text style={styles.statusMsg}>
              {isConnected
                ? connectedVin
                  ? `Vehicle VIN ${connectedVin}`
                  : "Reading vehicle…"
                : statusMessage || "No adapter connected."}
            </Text>
          </View>
        </View>

        {/* Remembered adapter — reconnect / forget (singleton owns the storage). */}
        {savedAdapter && !isConnected && (
          <View style={styles.savedRow}>
            <Text style={styles.savedText}>
              Remembered adapter: {savedAdapter.name || savedAdapter.deviceId}
            </Text>
            <View style={styles.savedActions}>
              <TouchableOpacity
                style={styles.secondaryBtn}
                onPress={onReconnect}
                disabled={reconnecting}
                accessibilityRole="button"
                accessibilityLabel="Reconnect to the remembered adapter"
              >
                {reconnecting ? (
                  <ActivityIndicator size="small" color={colors.accent} />
                ) : (
                  <Text style={styles.secondaryBtnText}>Reconnect</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.linkBtn}
                onPress={onForget}
                accessibilityRole="button"
                accessibilityLabel="Forget the remembered adapter"
              >
                <Text style={styles.linkBtnText}>Forget device</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {isConnected ? (
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Done"
          >
            <Text style={styles.primaryBtnText}>Done</Text>
          </TouchableOpacity>
        ) : (
          <>
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={onScan}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Scan for adapters"
            >
              {busy ? (
                <View style={styles.btnRow}>
                  <ActivityIndicator size="small" color="#FFFFFF" />
                  <Text style={styles.primaryBtnText}>Scanning…</Text>
                </View>
              ) : (
                <Text style={styles.primaryBtnText}>Scan for adapters</Text>
              )}
            </TouchableOpacity>

            {devices.length > 0 && (
              <View style={styles.deviceList}>
                {visibleObd.length > 0 && (
                  <Text style={styles.deviceGroupLabel}>OBD2 adapters</Text>
                )}
                {visibleObd.map((d) => (
                  <DeviceRow
                    key={d.id}
                    device={d}
                    connecting={connecting === d.id}
                    onPress={() => onSelectDevice(d)}
                  />
                ))}
                {visibleOther.length > 0 && (
                  <Text style={styles.deviceGroupLabel}>Other devices</Text>
                )}
                {visibleOther.map((d) => (
                  <DeviceRow
                    key={d.id}
                    device={d}
                    connecting={connecting === d.id}
                    onPress={() => onSelectDevice(d)}
                  />
                ))}
              </View>
            )}

            {!busy && devices.length === 0 && (
              <Text style={styles.hint}>
                Make sure the adapter is plugged into the OBD2 port and the
                ignition is on, then scan.
              </Text>
            )}
          </>
        )}

        <TouchableOpacity
          style={styles.advancedLink}
          onPress={() => router.push("/obd2")}
          accessibilityRole="button"
          accessibilityLabel="Open the full OBD2 screen"
        >
          <Text style={styles.advancedLinkText}>
            Live data &amp; advanced OBD2 →
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function DeviceRow({
  device,
  connecting,
  onPress,
}: {
  device: DiscoveredDevice;
  connecting: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={styles.deviceRow}
      onPress={onPress}
      disabled={connecting}
      accessibilityRole="button"
      accessibilityLabel={`Connect to ${device.name || device.id}`}
    >
      <View style={styles.deviceInfo}>
        <Text style={styles.deviceName}>{device.name || "Unknown device"}</Text>
        <Text style={styles.deviceMeta}>
          {device.transport}
          {device.rssi != null ? ` · ${device.rssi} dBm` : ""}
        </Text>
      </View>
      {connecting ? (
        <ActivityIndicator size="small" color={colors.accent} />
      ) : (
        <Text style={styles.deviceChevron}>›</Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 40,
    gap: 16,
  },
  h1: {
    fontSize: 26,
    fontWeight: "600",
    color: colors.heading,
    letterSpacing: -0.3,
  },
  subtitle: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 21,
    marginTop: -8,
  },
  statusCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 16,
    gap: 12,
  },
  statusDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  dotConnected: {
    backgroundColor: colors.accent,
  },
  dotIdle: {
    backgroundColor: colors.muted,
  },
  statusBody: {
    flex: 1,
    gap: 2,
  },
  statusTitle: {
    color: colors.heading,
    fontSize: 16,
    fontWeight: "600",
  },
  statusMsg: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
  },
  savedRow: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 16,
    gap: 12,
  },
  savedText: {
    color: colors.heading,
    fontSize: 14,
  },
  savedActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  secondaryBtn: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: 18,
    paddingVertical: 10,
    minHeight: HIT_TARGET,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryBtnText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "600",
  },
  linkBtn: {
    paddingVertical: 10,
    minHeight: HIT_TARGET,
    justifyContent: "center",
  },
  linkBtnText: {
    color: colors.muted,
    fontSize: 14,
    fontWeight: "500",
  },
  primaryBtn: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: 16,
    minHeight: HIT_TARGET,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "600",
  },
  btnRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  deviceList: {
    gap: 8,
  },
  deviceGroupLabel: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginTop: 8,
  },
  deviceRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    minHeight: HIT_TARGET,
    gap: 12,
  },
  deviceInfo: {
    flex: 1,
    gap: 2,
  },
  deviceName: {
    color: colors.heading,
    fontSize: 15,
    fontWeight: "500",
  },
  deviceMeta: {
    color: colors.muted,
    fontSize: 12,
  },
  deviceChevron: {
    color: colors.muted,
    fontSize: 24,
    fontWeight: "300",
  },
  hint: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    paddingHorizontal: 8,
  },
  advancedLink: {
    alignSelf: "center",
    paddingVertical: 10,
    minHeight: HIT_TARGET,
    justifyContent: "center",
    marginTop: 8,
  },
  advancedLinkText: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: "500",
  },
});
