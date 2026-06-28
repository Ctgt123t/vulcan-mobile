// ============================================================================
// In-app full-screen zoomable image viewer for diagram results (Fix 2b/2c).
// Tapping a diagram thumbnail opens THIS (in-app), instead of ejecting to an
// external browser. Pinch + pan + double-tap zoom via react-native-gesture-
// handler + reanimated (both already in the binary -> ships OTA, no rebuild).
//
// Display layer only — does NOT touch the diagram search logic, the §3
// year/generation guard, the no-fabrication rules, or server/diagramLookup.js.
// We enlarge the Brave `thumbnailUrl` (the only image URL the result carries; a
// higher-res source image would require a fenced server/search change). A
// "View source" link is offered here too so provenance is never lost. The
// source link still uses Linking (external) for now — upgrading it to an in-app
// browser sheet needs a native dep (expo-web-browser / react-native-webview),
// which is flagged for a separate rebuild.
// ============================================================================

import { Image } from "expo-image";
import { Linking, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import type { DiagramResult } from "../lib/types";
import { colors, fonts } from "../lib/theme";

const MAX_SCALE = 6;
const DOUBLE_TAP_SCALE = 2.5;

export default function ImageZoomViewer({
  diagram,
  onClose,
}: {
  diagram: DiagramResult | null;
  onClose: () => void;
}) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);

  // JS-thread reset (called from the close button + on open of a new image).
  function resetTransform() {
    scale.value = withTiming(1);
    savedScale.value = 1;
    tx.value = withTiming(0);
    ty.value = withTiming(0);
    savedTx.value = 0;
    savedTy.value = 0;
  }

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.max(1, Math.min(savedScale.value * e.scale, MAX_SCALE));
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      if (scale.value <= 1) {
        tx.value = withTiming(0);
        ty.value = withTiming(0);
        savedTx.value = 0;
        savedTy.value = 0;
      }
    });

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      tx.value = savedTx.value + e.translationX;
      ty.value = savedTy.value + e.translationY;
    })
    .onEnd(() => {
      savedTx.value = tx.value;
      savedTy.value = ty.value;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      if (scale.value > 1) {
        scale.value = withTiming(1);
        savedScale.value = 1;
        tx.value = withTiming(0);
        ty.value = withTiming(0);
        savedTx.value = 0;
        savedTy.value = 0;
      } else {
        scale.value = withTiming(DOUBLE_TAP_SCALE);
        savedScale.value = DOUBLE_TAP_SCALE;
      }
    });

  const gesture = Gesture.Exclusive(
    doubleTap,
    Gesture.Simultaneous(pinch, pan),
  );

  const imgStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
      { scale: scale.value },
    ],
  }));

  function close() {
    resetTransform();
    onClose();
  }

  return (
    <Modal
      visible={!!diagram}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={close}
    >
      <GestureHandlerRootView style={styles.root}>
        <View style={styles.backdrop}>
          {diagram ? (
            <GestureDetector gesture={gesture}>
              <Animated.View style={[styles.imageWrap, imgStyle]}>
                <Image
                  source={{ uri: diagram.thumbnailUrl }}
                  style={styles.image}
                  contentFit="contain"
                />
              </Animated.View>
            </GestureDetector>
          ) : null}

          <Pressable
            style={styles.closeBtn}
            onPress={close}
            hitSlop={14}
            accessibilityRole="button"
            accessibilityLabel="Close image viewer"
          >
            <Text style={styles.closeText}>✕</Text>
          </Pressable>

          {diagram ? (
            <View style={styles.footer}>
              <Pressable
                onPress={() => Linking.openURL(diagram.sourceUrl).catch(() => {})}
                accessibilityRole="link"
                hitSlop={8}
              >
                <Text style={styles.sourceText} numberOfLines={1}>
                  View source: {diagram.domain} ↗
                </Text>
              </Pressable>
              <Text style={styles.brave}>Powered by Brave</Text>
              <Text style={styles.hint}>Pinch or double-tap to zoom</Text>
            </View>
          ) : null}
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.92)",
    alignItems: "center",
    justifyContent: "center",
  },
  imageWrap: { width: "100%", height: "100%", alignItems: "center", justifyContent: "center" },
  image: { width: "100%", height: "82%", backgroundColor: "#FFFFFF" },
  closeBtn: {
    position: "absolute",
    top: 48,
    right: 20,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  closeText: { color: "#FFFFFF", fontSize: 18, fontFamily: fonts.sansSemibold },
  footer: {
    position: "absolute",
    bottom: 40,
    left: 20,
    right: 20,
    alignItems: "center",
    gap: 4,
  },
  sourceText: { color: colors.accent, fontSize: 14, fontFamily: fonts.sansSemibold },
  brave: { color: colors.muted, fontSize: 11, fontFamily: fonts.sans },
  hint: { color: colors.faint, fontSize: 11, fontFamily: fonts.sans, marginTop: 2 },
});
