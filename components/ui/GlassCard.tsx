import { BlurView } from "expo-blur";
import type { ReactNode } from "react";
import {
  Pressable,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native";
import { colors, radii } from "../../lib/theme";

// ============================================================================
// v2 "steel glass" panel — the reusable surface v2 screens compose from.
//
// Composition: a crisp rounded (overflow-clipped) container with a translucent
// steel TINT (the legibility floor) + a hairline rim + a subtle top highlight,
// content above. The recipe's 180deg sheen is approximated by the flat tint +
// the top highlight (expo-linear-gradient isn't installed — adding it would
// force a rebuild; this is OTA + performant and reads the same).
//
// Two modes:
//  - translucent (DEFAULT): no BlurView. Used for ALL cards / list rows.
//    Identical + smooth on both platforms; the tint over the atmosphere carries
//    the glass read. This is what home uses. Safe inside scrollers.
//  - frosted (opt-in): a BlurView behind the tint, for a FEW FIXED, non-
//    scrolling hero surfaces only (e.g. a sticky header). The tint is the
//    guaranteed fallback so it looks intentional on Android with or without
//    real RenderEffect blur. NEVER put a frosted card inside a scroller, and
//    keep the total count to ≤1–2.
//
// Legibility note: the dark atmosphere + light content already give high
// contrast with blur OFF and in bright ambient light — blur is never load-
// bearing for readability.
// ============================================================================

export default function GlassCard({
  children,
  style,
  frosted = false,
  onPress,
  accessibilityLabel,
}: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  frosted?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  const body = (
    <>
      {frosted && (
        <BlurView
          intensity={24}
          tint="dark"
          // Real-time blur on capable Android; the tint below is the fallback
          // when RenderEffect isn't available (Android < 12).
          experimentalBlurMethod="dimezisBlurView"
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      )}
      {/* Translucent steel tint — the legibility floor + glass color. */}
      <View
        style={[StyleSheet.absoluteFill, styles.tint]}
        pointerEvents="none"
      />
      {/* Subtle top sheen (stands in for the 180deg gradient's lighter top). */}
      <View style={styles.topHighlight} pointerEvents="none" />
      <View style={styles.content}>{children}</View>
    </>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={({ pressed }) => [
          styles.card,
          style,
          pressed && styles.pressed,
        ]}
      >
        {body}
      </Pressable>
    );
  }
  return <View style={[styles.card, style]}>{body}</View>;
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radii.sm, // crisp ~4px corners
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassRim,
    backgroundColor: "transparent",
  },
  pressed: {
    opacity: 0.85,
  },
  tint: {
    backgroundColor: colors.glassFill,
  },
  topHighlight: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: colors.glassHighlight,
  },
  content: {
    // Content draws above the tint/blur/highlight layers.
  },
});
