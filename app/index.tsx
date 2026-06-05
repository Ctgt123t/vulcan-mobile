// PLACEHOLDER AUTH SCREEN — real authentication (Supabase, Firebase, Clerk, etc.)
// will replace this. For now `onSignIn` skips all credential checks and routes
// straight to /home so the rest of the navigation flow can be exercised.

import { useRouter } from "expo-router";
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import BrandMark from "../components/BrandMark";
import { HIT_TARGET, colors } from "../lib/theme";

export default function SignInScreen() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  function onSignIn() {
    // PLACEHOLDER: no credential check. Replace with a real auth call before
    // shipping; see DEV_SETUP.md for the migration plan.
    router.replace("/home");
  }

  function onSignUp() {
    // PLACEHOLDER: sign-up flow is not implemented yet.
  }

  return (
    <SafeAreaView
      style={styles.safe}
      edges={["top", "bottom", "left", "right"]}
    >
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.brand}>
            <BrandMark size={52} />
            <Text style={styles.brandName}>Vulcan</Text>
            <View style={styles.proBadge}>
              <Text style={styles.proBadgeText}>PRO</Text>
            </View>
          </View>
          <Text style={styles.tagline}>
            Technician-side diagnostic assistant.
          </Text>

          <View style={styles.card}>
            <View style={styles.field}>
              <Text style={styles.label}>EMAIL</Text>
              <TextInput
                style={styles.input}
                value={email}
                onChangeText={setEmail}
                placeholder="tech@shop.com"
                placeholderTextColor={colors.muted}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.label}>PASSWORD</Text>
              <TextInput
                style={styles.input}
                value={password}
                onChangeText={setPassword}
                placeholder="••••••••"
                placeholderTextColor={colors.muted}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            <TouchableOpacity
              style={styles.submit}
              onPress={onSignIn}
              activeOpacity={0.85}
              accessibilityLabel="Sign in"
            >
              <Text style={styles.submitText}>Sign in</Text>
            </TouchableOpacity>

            <Text style={styles.placeholderNote}>
              Placeholder — real authentication coming soon.
            </Text>
          </View>

          <View style={styles.signupRow}>
            <Text style={styles.signupText}>No account yet? </Text>
            <TouchableOpacity
              onPress={onSignUp}
              activeOpacity={0.6}
              accessibilityLabel="Sign up"
              hitSlop={12}
            >
              <Text style={styles.signupLink}>Sign up</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  flex: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    marginBottom: 8,
  },
  brandName: {
    color: colors.heading,
    fontSize: 32,
    fontWeight: "700",
    letterSpacing: -0.5,
  },
  proBadge: {
    backgroundColor: colors.accentFade,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  proBadgeText: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.2,
  },
  tagline: {
    color: colors.muted,
    fontSize: 14,
    textAlign: "center",
    marginBottom: 32,
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 18,
  },
  field: {
    marginBottom: 14,
  },
  label: {
    fontSize: 11,
    fontWeight: "500",
    color: colors.muted,
    letterSpacing: 0.7,
    marginBottom: 6,
  },
  input: {
    minHeight: HIT_TARGET,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 6,
  },
  submit: {
    marginTop: 6,
    minHeight: HIT_TARGET,
    backgroundColor: colors.accent,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  submitText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  placeholderNote: {
    marginTop: 12,
    color: colors.muted,
    fontSize: 11,
    textAlign: "center",
    fontStyle: "italic",
  },
  signupRow: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    marginTop: 22,
    minHeight: HIT_TARGET,
  },
  signupText: {
    color: colors.muted,
    fontSize: 14,
  },
  signupLink: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "600",
  },
});
