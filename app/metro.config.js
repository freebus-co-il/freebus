// Sentry's wrapper around Expo's default config. It stamps every bundle and
// its source map with a matching debug id, which is how a crash report from
// any store build or update finds the right source map.
const { getSentryExpoConfig } = require('@sentry/react-native/metro');

const config = getSentryExpoConfig(__dirname);
config.resolver.sourceExts.push('mjs');

module.exports = config;
