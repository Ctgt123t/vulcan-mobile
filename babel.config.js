module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    // Reanimated v4 split the worklets engine into the standalone
    // react-native-worklets package, and the babel plugin moved with it.
    // The old "react-native-reanimated/plugin" was the v3 name — keeping
    // it under v4 means worklets never get transformed and the iOS
    // runtime asserts at startup (Swift _assertionFailure crash, which
    // is what we saw on iPhone). On New Architecture this fires
    // immediately; on Android the runtime is more lenient which is why
    // the same codebase ran fine there. v4 docs:
    // https://docs.swmansion.com/react-native-reanimated/docs/4.x/
    plugins: ["react-native-worklets/plugin"],
  };
};
