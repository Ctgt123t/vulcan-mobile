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
import Background from "../components/ui/Background";
import GlassCard from "../components/ui/GlassCard";
import { HIT_TARGET, colors, fonts, radii } from "../lib/theme";

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
    <Background>
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
            showsVerticalScrollIndicator={false}
          >
            {/* Stacked warm brand hero */}
            <View style={styles.brand}>
              <BrandMark size={64} glow />
              <Text style={styles.brandName}>Vulcan</Text>
              <Text style={styles.tagline}>Diagnostic Assistant</Text>
            </View>

            {/* Frosted-glass auth card — the reserved real-blur surface (fixed,
                non-scrolling). The steel tint carries legibility with blur OFF
                (Android < 12 fallback). */}
            <GlassCard frosted style={styles.card}>
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
            </GlassCard>

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
    </Background>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "transparent", // the atmosphere (Background) shows through
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
    alignItems: "center",
    gap: 12,
    marginBottom: 28,
  },
  brandName: {
    color: colors.heading,
    fontSize: 32,
    fontFamily: fonts.sansBold,
    letterSpacing: -0.5,
  },
  tagline: {
    color: colors.muted,
    fontSize: 14,
    fontFamily: fonts.sans,
    textAlign: "center",
  },
  card: {
    width: "100%",
    maxWidth: 440,
    alignSelf: "center",
    padding: 18,
  },
  field: {
    marginBottom: 14,
  },
  label: {
    fontSize: 11,
    fontFamily: fonts.sansSemibold,
    color: colors.muted,
    letterSpacing: 1.2,
    marginBottom: 7,
  },
  // Recessed well inside the glass card — a slightly darker translucent fill so
  // the field reads as inset against the frosted surface.
  input: {
    minHeight: HIT_TARGET,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: fonts.sans,
    color: colors.text,
    backgroundColor: "rgba(12, 15, 18, 0.30)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassRim,
    borderRadius: radii.sm,
  },
  submit: {
    marginTop: 6,
    minHeight: HIT_TARGET,
    backgroundColor: colors.accent, // solid light steel
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  submitText: {
    color: colors.bg, // dark text on steel
    fontSize: 15,
    fontFamily: fonts.sansSemibold,
    letterSpacing: 0.3,
  },
  placeholderNote: {
    marginTop: 12,
    color: colors.muted,
    fontSize: 11,
    textAlign: "center",
    fontStyle: "italic",
    fontFamily: fonts.sans,
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
    fontFamily: fonts.sans,
  },
  signupLink: {
    color: colors.accent, // steel accent #C8D6E4
    fontSize: 14,
    fontFamily: fonts.sansSemibold,
  },
});
