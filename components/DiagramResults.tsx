import { useState } from "react";
import { Image, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import type { DiagramLookupResult, DiagramResult } from "../lib/types";
import { colors } from "../lib/theme";
import ImageZoomViewer from "./ImageZoomViewer";

// Shared diagram-results card (Ask Vulcan + the mid-diagnosis "Find a diagram"
// affordance). Search-engine posture: real open-web thumbnails, a conspicuous
// "Powered by Brave" attribution (ToS), and an always-present "search the web"
// fallback so nothing dead-ends. We never claim these as Vulcan data and never
// describe their contents (that's the model's job elsewhere — forbidden too).
//
// Tap split (Fix 2c): tapping the IMAGE opens the in-app zoom viewer (it no
// longer ejects to an external browser); only the explicit domain/title link
// opens the SOURCE page. The source still uses Linking (external) for now —
// an in-app browser sheet needs a native dep, flagged separately.

const TYPE_LABEL: Record<string, string> = {
  fuse: "fuse box",
  component: "belt / component",
  wiring: "wiring",
};

function Thumb({
  d,
  onOpen,
}: {
  d: DiagramResult;
  onOpen: (d: DiagramResult) => void;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <View style={styles.thumbWrap}>
      {/* IMAGE tap -> in-app zoom viewer (not the website). */}
      <Pressable
        onPress={() => onOpen(d)}
        accessibilityRole="imagebutton"
        accessibilityLabel={`Enlarge ${d.title || d.domain} diagram`}
      >
        {failed ? (
          <View style={[styles.thumb, styles.thumbMissing]}>
            <Text style={styles.missingText}>image unavailable</Text>
          </View>
        ) : (
          <Image
            source={{ uri: d.thumbnailUrl }}
            style={styles.thumb}
            resizeMode="cover"
            onError={() => setFailed(true)}
          />
        )}
      </Pressable>
      {/* Explicit SOURCE link (domain + title) -> the source page. */}
      <Pressable
        onPress={() => Linking.openURL(d.sourceUrl).catch(() => {})}
        accessibilityRole="link"
        accessibilityLabel={`Open source: ${d.domain}`}
        hitSlop={6}
      >
        <Text style={styles.domain} numberOfLines={1}>
          {d.domain} ↗
        </Text>
        {d.title ? (
          <Text style={styles.title} numberOfLines={2}>
            {d.title}
          </Text>
        ) : null}
      </Pressable>
    </View>
  );
}

export default function DiagramResults({ result }: { result: DiagramLookupResult }) {
  const [zoom, setZoom] = useState<DiagramResult | null>(null);
  const label = TYPE_LABEL[result.type] ?? result.type;
  const has = result.images.length > 0;
  return (
    <View style={styles.card}>
      <Text style={styles.header}>
        {has ? `${label} diagram${result.images.length > 1 ? "s" : ""}` : `No verified ${label} diagram found`}
      </Text>

      {has ? (
        <View style={styles.row}>
          {result.images.map((d, i) => (
            <Thumb key={`${d.sourceUrl}-${i}`} d={d} onOpen={setZoom} />
          ))}
        </View>
      ) : (
        <Text style={styles.note}>
          {result.supported
            ? "Couldn't confirm a diagram for this exact year — tap below to search the web."
            : "Diagrams for this type aren't surfaced in-app — tap below to search the web."}
        </Text>
      )}

      {/* Universal fallback — always present, never a dead end. */}
      <Pressable
        style={styles.searchLink}
        onPress={() => Linking.openURL(result.webSearchUrl).catch(() => {})}
        accessibilityRole="link"
      >
        <Text style={styles.searchLinkText}>🔎 Search the web for this diagram ↗</Text>
      </Pressable>

      <Text style={styles.attribution}>{result.attribution || "Powered by Brave"}</Text>

      <ImageZoomViewer diagram={zoom} onClose={() => setZoom(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.glassFill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassRim,
    borderRadius: 8,
    padding: 10,
    marginTop: 8,
    gap: 8,
  },
  header: { color: colors.text, fontSize: 13, fontWeight: "600" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  thumbWrap: { width: 150 },
  thumb: {
    width: 150,
    height: 112,
    borderRadius: 6,
    backgroundColor: "#FFFFFF", // diagrams are line-art on white; show true colors
  },
  thumbMissing: {
    backgroundColor: colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  missingText: { color: colors.muted, fontSize: 11 },
  domain: { color: colors.accent, fontSize: 11, marginTop: 3 },
  title: { color: colors.muted, fontSize: 11, marginTop: 1 },
  note: { color: colors.muted, fontSize: 12 },
  searchLink: { paddingVertical: 4 },
  searchLinkText: { color: colors.accent, fontSize: 13, fontWeight: "600" },
  attribution: { color: colors.muted, fontSize: 10, opacity: 0.8 },
});
