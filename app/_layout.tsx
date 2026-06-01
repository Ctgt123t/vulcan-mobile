import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Obd2Provider } from "../contexts/Obd2Context";
import { VehicleProvider } from "../contexts/VehicleContext";
import { diagnosticLogger } from "../lib/diagnosticLogger";
import { colors } from "../lib/theme";

export default function RootLayout() {
  useEffect(() => {
    // Load historical log entries from AsyncStorage on app start.
    diagnosticLogger.initialize().catch(() => {});
  }, []);

  return (
    <SafeAreaProvider>
      <Obd2Provider>
        <VehicleProvider>
          <View style={styles.root}>
            <StatusBar style="dark" backgroundColor={colors.surface} />
            <Stack screenOptions={{ headerShown: false, contentStyle: styles.root }} />
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
