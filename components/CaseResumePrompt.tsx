import { useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { Alert } from "react-native";
import { useObd2 } from "../contexts/Obd2Context";
import { useVehicle } from "../contexts/VehicleContext";
import { isDiagnoseSessionActive } from "../lib/activeDiagnoseSession";
import { findOpenCasesByVin } from "../lib/diagnosticCases";

// VIN-match auto-prompt (Stage 2B). Mounted once at the root, inside the OBD2 +
// Vehicle providers. When an adapter connects and its VIN resolves, offers to
// resume any OPEN case(s) saved for that vehicle. Renders nothing.
//
// Why here and not in VehicleContext: the prompt is mode-specific UI; the
// context stays free of it. Why it reads the context VIN (not obd2.getConnectedVin
// directly): it fires on the *commit* of an obd2-auto VIN into the context,
// which happens AFTER VehicleContext's own connect-time mismatch alert resolves
// — so the two alerts can never stack.
//
// Suppression rules:
//   - once per connect (lastPromptedVin ref; reset on disconnect so a reconnect
//     re-prompts),
//   - only for a connection-sourced VIN (source === "obd2-auto"), never a manual
//     entry,
//   - never while a diagnose chat session is active (isDiagnoseSessionActive) —
//     don't hijack a mid-thread diagnosis.
export default function CaseResumePrompt() {
  const { vin, source } = useVehicle();
  const { isConnected, status } = useObd2();
  const router = useRouter();
  const lastPromptedVin = useRef<string | null>(null);

  useEffect(() => {
    if (!isConnected) {
      // Allow a fresh prompt on the next connect.
      if (status === "idle" || status === "error") {
        lastPromptedVin.current = null;
      }
      return;
    }
    if (source !== "obd2-auto" || !vin) return;
    if (lastPromptedVin.current === vin) return;
    if (isDiagnoseSessionActive()) return; // don't interrupt an active diagnosis
    lastPromptedVin.current = vin;

    let cancelled = false;
    findOpenCasesByVin(vin)
      .then((matches) => {
        if (cancelled || matches.length === 0) return;
        if (matches.length === 1) {
          const m = matches[0];
          Alert.alert(
            "Open case for this vehicle",
            `${m.vehicleLabel}\n${m.complaintPreview}\n\nResume this diagnosis?`,
            [
              { text: "Not now", style: "cancel" },
              {
                text: "Resume",
                onPress: () =>
                  router.navigate({
                    pathname: "/chat",
                    params: { resume: m.id },
                  }),
              },
            ],
          );
        } else {
          Alert.alert(
            "Open cases for this vehicle",
            `You have ${matches.length} open diagnostic cases for this vehicle. Open the list to pick one.`,
            [
              { text: "Not now", style: "cancel" },
              {
                text: "View cases",
                onPress: () =>
                  router.navigate({
                    pathname: "/chat",
                    params: { mode: "diagnose", focusVin: vin },
                  }),
              },
            ],
          );
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [vin, source, isConnected, status, router]);

  return null;
}
