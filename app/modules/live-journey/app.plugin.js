const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

/**
 * The journey's picture-in-picture window is the app's own activity, shrunk,
 * so that activity has to say it supports PiP. `android/` is generated, so
 * this is the only durable place to say it. The existing `configChanges`
 * already cover the size changes, which is what keeps entering PiP from
 * recreating the activity and the JS state with it.
 */
module.exports = function withJourneyPip(config) {
  return withAndroidManifest(config, (modConfig) => {
    const mainActivity = AndroidConfig.Manifest.getMainActivityOrThrow(modConfig.modResults);
    mainActivity.$['android:supportsPictureInPicture'] = 'true';
    return modConfig;
  });
};
