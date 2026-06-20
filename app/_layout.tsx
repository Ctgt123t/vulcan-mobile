import {
  IBMPlexMono_400Regular,
  IBMPlexMono_500Medium,
} from "@expo-google-fonts/ibm-plex-mono";
import {
  IBMPlexSans_400Regular,
  IBMPlexSans_500Medium,
  IBMPlexSans_600SemiBold,
  IBMPlexSans_700Bold,
  useFonts,
} from "@expo-google-fonts/ibm-plex-sans";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import CaseResumePrompt from "../components/CaseResumePrompt";
import { Obd2Provider } from "../contexts/Obd2Context";
import { VehicleProvider } from "../contexts/VehicleContext";
import { applyGlobalFont } from "../lib/applyGlobalFont";
import { diagnosticLogger } from "../lib/diagnosticLogger";
import { colors } from "../lib/theme";

// Patch Text/TextInput once, at module load, BEFORE any screen text renders, so
// the whole app types in IBM Plex Sans (weight-aware) without per-screen edits.
applyGlobalFont();

export default function RootLayout() {
  // IBM Plex loads at runtime from the JS/asset bundle — expo-font is already in
  // the native binary, so this ships OTA (no eas build). We gate first paint on
  // a dark full-screen view (NOT expo-splash-screen, which would be a new native
  // dependency / a rebuild) so text never flashes system-font → Plex.
  const [fontsLoaded, fontError] = useFonts({
    IBMPlexSans_400Regular,
    IBMPlexSans_500Medium,
    IBMPlexSans_600SemiBold,
    IBMPlexSans_700Bold,
    IBMPlexMono_400Regular,
    IBMPlexMono_500Medium,
  });

  useEffect(() => {
    // Load historical log entries from AsyncStorage on app start.
    diagnosticLogger.initialize().catch(() => {});
  }, []);

  // Gate first paint until fonts resolve (no system-font → Plex flash). The
  // WHOLE app is behind this gate, so it must NEVER hang: if font loading fails
  // (missing asset, corrupt file), proceed anyway — the global patch falls back
  // to the platform font (a cosmetic miss, not a blank-screen lockup).
  if (!fontsLoaded && !fontError) {
    // Dark hold frame — no white flash, no system-font flash, no native dep.
    return <View style={styles.root} />;
  }

  return (
    <SafeAreaProvider>
      <Obd2Provider>
        <VehicleProvider>
          <View style={styles.root}>
            <StatusBar style="light" backgroundColor={colors.surface} />
            <Stack screenOptions={{ headerShown: false, contentStyle: styles.root }} />
            {/* Renders nothing — watches for a connecting VIN and offers to
                resume matching open cases (Stage 2B). */}
            <CaseResumePrompt />
          </View>
        </VehicleProvider>
      </Obd2Provider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
});
