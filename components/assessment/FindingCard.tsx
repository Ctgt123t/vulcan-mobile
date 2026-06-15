import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import {
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { COULDNT_CHECK_LABEL } from "../../lib/findingOptions";
import { HIT_TARGET, colors } from "../../lib/theme";

// Stage 3 (Step 1) guided result-capture card — PRESENTATIONAL ONLY. Renders
// the brain-authored inspection outcomes as big, glove-friendly tap buttons,
// plus an ALWAYS-present "Couldn't check" button and a "Type it instead"
// free-text escape (the model never authors those, so they can't be missing).
// No logic lives here: the host (app/diagnose.tsx) wires the callbacks and
// composes the user-message string, exactly like CaptureCard.
//
// PHOTO SEAM (design only — NOT built): onAttachPhoto is reserved so a future
// "show me what you're looking at" photo attach can drop into this card without
// a redesign. When absent (today), no photo affordance renders.

export default function FindingCard({
  action,
  outcomes,
  onOutcome,
  onCouldntCheck,
  onFreeText,
  onAttachPhoto,
}: {
  action: string;
  outcomes: string[];
  onOutcome: (outcome: string) => void;
  onCouldntCheck: () => void;
  onFreeText: (text: string) => void;
  onAttachPhoto?: () => void; // photo seam — disabled/absent for now
}) {
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");

  function submitDraft() {
    const t = draft.trim();
    if (!t) return;
    setDraft("");
    setTyping(false);
    onFreeText(t);
  }

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Ionicons name="hand-left-outline" size={18} color={colors.accent} />
        <Text style={styles.title}>What did you find?</Text>
      </View>
      {action.length > 0 && <Text style={styles.action}>{action}</Text>}

      {/* Brain-authored outcomes — big tap targets */}
      <View style={styles.outcomeList}>
        {outcomes.map((o) => (
          <TouchableOpacity
            key={o}
            style={styles.outcomeBtn}
            onPress={() => onOutcome(o)}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel={`Finding: ${o}`}
          >
            <Text style={styles.outcomeText}>{o}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Always-present escapes (client-synthesized, never brain-authored) */}
      <View style={styles.escapeRow}>
        <TouchableOpacity
          style={styles.escapeBtn}
          onPress={onCouldntCheck}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel={COULDNT_CHECK_LABEL}
        >
          <Ionicons name="help-circle-outline" size={16} color={colors.muted} />
          <Text style={styles.escapeText}>{COULDNT_CHECK_LABEL}</Text>
        </TouchableOpacity>

        {!typing && (
          <TouchableOpacity
            style={styles.escapeBtn}
            onPress={() => setTyping(true)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Type it instead"
          >
            <Ionicons name="create-outline" size={16} color={colors.muted} />
            <Text style={styles.escapeText}>Type it instead</Text>
          </TouchableOpacity>
        )}

        {/* PHOTO SEAM: renders only when a handler is supplied (none today). */}
        {onAttachPhoto && (
          <TouchableOpacity
            style={styles.escapeBtn}
            onPress={onAttachPhoto}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Add a photo"
          >
            <Ionicons name="camera-outline" size={16} color={colors.muted} />
            <Text style={styles.escapeText}>Add photo</Text>
          </TouchableOpacity>
        )}
      </View>

      {typing && (
        <View style={styles.freeTextWrap}>
          <TextInput
            style={styles.freeTextInput}
            value={draft}
            onChangeText={setDraft}
            placeholder="Describe what you found…"
            placeholderTextColor={colors.muted}
            multiline
            autoFocus
          />
          <TouchableOpacity
            style={[styles.sendBtn, !draft.trim() && styles.sendBtnDisabled]}
            onPress={submitDraft}
            disabled={!draft.trim()}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Send finding"
          >
            <Text style={styles.sendBtnText}>Send</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent,
    backgroundColor: colors.surface,
    padding: 14,
    gap: 12,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  title: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.heading,
  },
  action: {
    fontSize: 13,
    color: colors.text,
    lineHeight: 19,
  },
  // Outcome buttons — large, glove-friendly, navy-accented
  outcomeList: {
    gap: 8,
  },
  outcomeBtn: {
    minHeight: HIT_TARGET,
    justifyContent: "center",
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent,
    backgroundColor: colors.accentFade,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  outcomeText: {
    fontSize: 15,
    fontWeight: "700",
    color: colors.accent,
  },
  // Secondary escapes
  escapeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingTop: 2,
  },
  escapeBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: HIT_TARGET - 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface2,
  },
  escapeText: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.muted,
  },
  // Free-text escape
  freeTextWrap: {
    gap: 8,
  },
  freeTextInput: {
    minHeight: HIT_TARGET,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.text,
    textAlignVertical: "top",
  },
  sendBtn: {
    alignSelf: "flex-end",
    minHeight: HIT_TARGET - 8,
    justifyContent: "center",
    borderRadius: 10,
    backgroundColor: colors.accent,
    paddingHorizontal: 24,
  },
  sendBtnDisabled: {
    backgroundColor: colors.borderStrong,
  },
  sendBtnText: {
    color: colors.userText,
    fontSize: 14,
    fontWeight: "700",
  },
});
