// React Native autolinking override (read by Expo's `react-native-config`
// resolver, which feeds both the iOS Podfile `use_native_modules!` and Android
// autolinking).
//
// iOS-ONLY EXCLUSION of react-native-bluetooth-classic.
//   - It is the Android Classic/SPP OBD2 transport. Its JS is already gated off
//     on iOS (import type + `Platform.OS === "android"` lazy-require in
//     lib/obd2.ts), but its CocoaPod still autolinks into the iOS binary under
//     the managed/prebuild (CNG) workflow — dead weight on iOS plus a latent
//     native-init crash risk (iOS uses the BLE transport, react-native-ble-plx).
//   - Setting `platforms.ios = null` removes ONLY the iOS pod. `platforms.android`
//     is untouched (left to default autolinking), so the Android Classic
//     transport links and works exactly as before. iOS-scoped, nothing else.
module.exports = {
  dependencies: {
    "react-native-bluetooth-classic": {
      platforms: {
        ios: null,
      },
    },
  },
};
