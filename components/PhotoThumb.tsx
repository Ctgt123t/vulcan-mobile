import { useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import type { ImageAttachment } from "../lib/types";
import { colors } from "../lib/theme";

// Shared in-bubble photo thumbnail (Photo Evidence) — used by both Diagnose and
// Ask Vulcan user message rows. A dangling local URI (reinstall / OS cache
// purge) degrades to a placeholder, never a crash. Presentational only.
export default function PhotoThumb({ image }: { image: ImageAttachment }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <View style={styles.photoMissing}>
        <Text style={styles.photoMissingText}>📷 photo (not available)</Text>
      </View>
    );
  }
  return (
    <Image
      source={{ uri: image.uri }}
      style={styles.photoThumb}
      resizeMode="cover"
      onError={() => setFailed(true)}
      accessibilityLabel="Attached photo"
    />
  );
}

const styles = StyleSheet.create({
  photoThumb: {
    width: 200,
    height: 150,
    borderRadius: 8,
    marginBottom: 6,
    backgroundColor: colors.surface2,
  },
  photoMissing: {
    width: 200,
    height: 90,
    borderRadius: 8,
    marginBottom: 6,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  photoMissingText: {
    fontSize: 12,
    color: colors.muted,
  },
});
