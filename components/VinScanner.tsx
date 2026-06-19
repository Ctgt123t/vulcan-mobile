import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useEffect, useRef, useState } from "react";
import {
  Animated,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { HIT_TARGET, colors } from "../lib/theme";
import { extractVin, vinCheckDigitValid } from "../lib/vin";

type Props = {
  visible: boolean;
  onClose: () => void;
  onScanned: (vin: string) => void;
};

type ScanMode = "barcode" | "qr";

const SUCCESS_COLOR = "#22C55E";
const LOWCONF_COLOR = "#F59E0B"; // amber — VIN captured but check digit didn't match
const SCRIM_COLOR = "rgba(0, 0, 0, 0.55)";

// Most iPads ship without a usable torch; expo-camera's enableTorch silently
// no-ops on them. We hide the button on iPad rather than show a broken one.
// iPhones and Android phones almost universally have a torch — keep it shown.
const TORCH_SUPPORTED = !(Platform.OS === "ios" && Platform.isPad);

// Window geometry per mode. Linear barcodes need a wide thin rectangle;
// QR codes are square so they get a roughly square window.
const WINDOW_GEOMETRY: Record<ScanMode, { widthPct: number; height: number }> = {
  barcode: { widthPct: 0.92, height: 120 },
  qr: { widthPct: 0.65, height: 260 },
};

export default function VinScanner({ visible, onClose, onScanned }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [torchOn, setTorchOn] = useState(false);
  const [mode, setMode] = useState<ScanMode>("barcode");
  // A VIN was captured but its ISO check digit didn't match — non-blocking
  // low-confidence signal (amber flash + a verify hint); the scan still proceeds.
  const [lowConfidence, setLowConfidence] = useState(false);
  const handledRef = useRef(false);
  const successAnim = useRef(new Animated.Value(0)).current;
  const dims = useWindowDimensions();

  const [cameraSize, setCameraSize] = useState({
    width: dims.width,
    height: dims.height,
  });

  const geo = WINDOW_GEOMETRY[mode];
  const windowWidth = cameraSize.width * geo.widthPct;
  const windowHeight = geo.height;

  // Reset on hide. Reset handledRef on mode change so a new scan can fire.
  useEffect(() => {
    if (!visible) {
      setTorchOn(false);
      setLowConfidence(false);
      handledRef.current = false;
      successAnim.setValue(0);
    }
  }, [visible, successAnim]);

  useEffect(() => {
    handledRef.current = false;
  }, [mode]);

  // Accept on a successful VIN PARSE — never on camera `bounds`. expo-camera
  // gives unreliable/empty bounds for iOS code39 (the dominant VIN format), so
  // the old spatial gate rejected ~90% of real detections. extractVin searches
  // for a 17-char VIN (handling a leading `I` import flag, *…* start/stop, or a
  // QR/URL payload); the reticle is now purely cosmetic guidance.
  function handleBarcode(result: { data: string }) {
    if (handledRef.current) return;
    const vin = extractVin(result.data);
    if (!vin) return;

    handledRef.current = true;
    // Soft check digit: a mismatch does NOT block — it flashes amber + shows a
    // verify hint and gives a slightly longer beat to read it before closing.
    const low = !vinCheckDigitValid(vin);
    setLowConfidence(low);
    Animated.timing(successAnim, {
      toValue: 1,
      duration: 180,
      useNativeDriver: false,
    }).start();
    setTimeout(
      () => {
        setTorchOn(false);
        onScanned(vin);
      },
      low ? 900 : 420,
    );
  }

  function handleClose() {
    setTorchOn(false);
    setLowConfidence(false);
    handledRef.current = false;
    successAnim.setValue(0);
    onClose();
  }

  function renderBody() {
    if (!permission) {
      return (
        <View style={styles.center}>
          <Text style={styles.body}>Checking camera permission…</Text>
        </View>
      );
    }

    if (!permission.granted) {
      return (
        <View style={styles.center}>
          <Text style={styles.heading}>Camera access required</Text>
          <Text style={styles.body}>
            Vulcan needs camera access to scan the VIN barcode on the driver
            door jamb sticker.
          </Text>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={requestPermission}
            activeOpacity={0.85}
          >
            <Text style={styles.primaryBtnText}>Grant camera access</Text>
          </TouchableOpacity>
        </View>
      );
    }

    const borderColor = successAnim.interpolate({
      inputRange: [0, 1],
      outputRange: ["#FFFFFF", lowConfidence ? LOWCONF_COLOR : SUCCESS_COLOR],
    });

    return (
      <View
        style={styles.cameraWrap}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          if (width !== cameraSize.width || height !== cameraSize.height) {
            setCameraSize({ width, height });
          }
        }}
      >
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          enableTorch={torchOn}
          // Counterintuitive but correct: in expo-camera, autofocus="off" means
          // "focus continuously when needed", while "on" means "focus once then
          // lock". For close-range door-jamb scanning we want continuous AF.
          autofocus="off"
          barcodeScannerSettings={{
            // VIN plates are overwhelmingly Code 39; the rest are cheap coverage
            // for less-common sticker encodings. (QR mode is its own payload.)
            barcodeTypes:
              mode === "qr"
                ? ["qr"]
                : [
                    "code39",
                    "code128",
                    "code93",
                    "itf14",
                    "pdf417",
                    "datamatrix",
                    "aztec",
                  ],
          }}
          onBarcodeScanned={handleBarcode}
        />

        {/* Scrim + brackets share the same flex skeleton so the clear cutout
            and the corner brackets occupy the same rect by construction. */}
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <View style={styles.bandTop}>
            <Text style={styles.instruction}>
              {mode === "qr"
                ? "Align QR code within frame"
                : "Align barcode within frame"}
            </Text>
          </View>
          <View style={[styles.bandMiddle, { height: windowHeight }]}>
            <View style={styles.scrimSide} />
            <View
              style={[
                styles.cutout,
                { width: windowWidth, height: windowHeight },
              ]}
            >
              <Animated.View
                style={[styles.corner, styles.cornerTL, { borderColor }]}
              />
              <Animated.View
                style={[styles.corner, styles.cornerTR, { borderColor }]}
              />
              <Animated.View
                style={[styles.corner, styles.cornerBL, { borderColor }]}
              />
              <Animated.View
                style={[styles.corner, styles.cornerBR, { borderColor }]}
              />
            </View>
            <View style={styles.scrimSide} />
          </View>
          <View style={styles.bandBottom}>
            <Text style={[styles.subhint, lowConfidence && styles.subhintWarn]}>
              {lowConfidence
                ? "VIN captured — double-check it (check digit didn't match)"
                : mode === "qr"
                  ? "Point at the VIN QR code"
                  : "Point at the VIN barcode — hold steady"}
            </Text>
          </View>
        </View>

        {/* Success flash — green check fades in over the window when a valid
            VIN is captured, just before the parent closes the modal. */}
        <Animated.View
          pointerEvents="none"
          style={[
            styles.successOverlay,
            {
              opacity: successAnim,
              transform: [
                {
                  scale: successAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.6, 1],
                  }),
                },
              ],
            },
          ]}
        >
          <View
            style={[
              styles.successCircle,
              lowConfidence && {
                backgroundColor: LOWCONF_COLOR,
                shadowColor: LOWCONF_COLOR,
              },
            ]}
          >
            <Ionicons
              name={lowConfidence ? "alert" : "checkmark"}
              size={42}
              color="#FFFFFF"
            />
          </View>
        </Animated.View>

        {TORCH_SUPPORTED && (
          <TouchableOpacity
            style={[styles.torchBtn, torchOn && styles.torchBtnActive]}
            onPress={() => setTorchOn((t) => !t)}
            activeOpacity={0.85}
            accessibilityLabel={torchOn ? "Turn off flashlight" : "Turn on flashlight"}
            accessibilityRole="button"
            accessibilityState={{ selected: torchOn }}
          >
            <Text style={[styles.torchIcon, torchOn && styles.torchIconActive]}>
              🔦
            </Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={handleClose}
    >
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <View style={styles.topBar}>
          <TouchableOpacity
            onPress={handleClose}
            style={styles.closeBtn}
            activeOpacity={0.85}
            accessibilityLabel="Close scanner"
          >
            <Text style={styles.closeText}>Cancel</Text>
          </TouchableOpacity>
          <Text style={styles.topTitle}>Scan VIN</Text>
          <View style={styles.closeBtn} />
        </View>

        <View style={styles.modeRow}>
          <ModeBtn
            label="Barcode"
            active={mode === "barcode"}
            onPress={() => setMode("barcode")}
          />
          <ModeBtn
            label="QR Code"
            active={mode === "qr"}
            onPress={() => setMode("qr")}
          />
        </View>

        {renderBody()}
      </SafeAreaView>
    </Modal>
  );
}

function ModeBtn({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.modeBtn, active && styles.modeBtnActive]}
      onPress={onPress}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`Scan mode: ${label}`}
    >
      <Text style={[styles.modeBtnText, active && styles.modeBtnTextActive]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const CORNER_SIZE = 22;
const CORNER_THICKNESS = 3;

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  closeBtn: {
    minWidth: HIT_TARGET + 24,
    minHeight: HIT_TARGET,
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  closeText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: "600",
  },
  topTitle: {
    color: colors.heading,
    fontSize: 16,
    fontWeight: "600",
    letterSpacing: 0.3,
  },

  modeRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  modeBtn: {
    flex: 1,
    minHeight: HIT_TARGET,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  modeBtnActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  modeBtnText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  modeBtnTextActive: {
    color: "#FFFFFF",
  },

  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    gap: 16,
  },
  heading: {
    color: colors.heading,
    fontSize: 18,
    fontWeight: "600",
  },
  body: {
    color: colors.text,
    fontSize: 14,
    textAlign: "center",
    lineHeight: 21,
  },
  primaryBtn: {
    minHeight: HIT_TARGET,
    paddingHorizontal: 18,
    backgroundColor: colors.accent,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnText: {
    color: "#FFFFFF",
    fontWeight: "600",
    fontSize: 15,
  },
  cameraWrap: {
    flex: 1,
    backgroundColor: "#000",
  },

  bandTop: {
    flex: 1,
    backgroundColor: SCRIM_COLOR,
    alignItems: "center",
    justifyContent: "flex-end",
    paddingBottom: 16,
    paddingHorizontal: 20,
  },
  bandMiddle: {
    flexDirection: "row",
  },
  scrimSide: {
    flex: 1,
    backgroundColor: SCRIM_COLOR,
  },
  cutout: {
    backgroundColor: "transparent",
  },
  bandBottom: {
    flex: 1,
    backgroundColor: SCRIM_COLOR,
    alignItems: "center",
    justifyContent: "flex-start",
    paddingTop: 16,
    paddingHorizontal: 20,
  },

  instruction: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: 0.3,
    textAlign: "center",
  },
  subhint: {
    color: "rgba(255, 255, 255, 0.85)",
    fontSize: 11,
    fontWeight: "500",
    letterSpacing: 1.2,
    textAlign: "center",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  subhintWarn: {
    color: LOWCONF_COLOR,
    letterSpacing: 0.3,
    fontWeight: "700",
  },

  corner: {
    position: "absolute",
    width: CORNER_SIZE,
    height: CORNER_SIZE,
  },
  cornerTL: {
    top: 0,
    left: 0,
    borderTopWidth: CORNER_THICKNESS,
    borderLeftWidth: CORNER_THICKNESS,
    borderTopLeftRadius: 4,
  },
  cornerTR: {
    top: 0,
    right: 0,
    borderTopWidth: CORNER_THICKNESS,
    borderRightWidth: CORNER_THICKNESS,
    borderTopRightRadius: 4,
  },
  cornerBL: {
    bottom: 0,
    left: 0,
    borderBottomWidth: CORNER_THICKNESS,
    borderLeftWidth: CORNER_THICKNESS,
    borderBottomLeftRadius: 4,
  },
  cornerBR: {
    bottom: 0,
    right: 0,
    borderBottomWidth: CORNER_THICKNESS,
    borderRightWidth: CORNER_THICKNESS,
    borderBottomRightRadius: 4,
  },

  successOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  successCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: SUCCESS_COLOR,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: SUCCESS_COLOR,
    shadowOpacity: 0.5,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 0 },
  },

  torchBtn: {
    position: "absolute",
    top: 16,
    right: 16,
    width: HIT_TARGET + 8,
    height: HIT_TARGET + 8,
    borderRadius: (HIT_TARGET + 8) / 2,
    backgroundColor: "rgba(0, 0, 0, 0.55)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  torchBtnActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accentHover,
  },
  torchIcon: {
    fontSize: 24,
    opacity: 0.75,
  },
  torchIconActive: {
    opacity: 1,
  },
});
