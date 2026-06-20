import { Image } from "expo-image";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { colors } from "../../lib/theme";

// ============================================================================
// v2 atmospheric background — the lit scene behind a screen's content.
//
// Renders the baked atmosphere PNG (scripts/genAtmosphere.mjs) as a FIXED,
// non-interactive bottom layer via expo-image. It is STATIC: it fills the
// screen container, so content/scroll views rendered as children scroll ABOVE
// it without it re-rendering or re-blurring — the key to smooth scrolling and
// to keeping any frosted glass cheap. `contentFit:"cover"` + the oversized
// square asset cover both portrait and landscape.
// ============================================================================

const ATMOSPHERE = require("../../assets/atmosphere.png");

export default function Background({ children }: { children?: ReactNode }) {
  return (
    <View style={styles.root}>
      <Image
        source={ATMOSPHERE}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        pointerEvents="none"
        cachePolicy="memory-disk"
        // The atmosphere is decorative; don't fade it in (avoids a flash).
        transition={0}
      />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    // Graphite under the image so any letterbox gap (extreme aspect) matches.
    backgroundColor: colors.bg,
  },
});
