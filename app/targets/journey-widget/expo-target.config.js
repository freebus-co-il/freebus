/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: 'widget',
  name: 'JourneyWidget',
  displayName: 'FreeBus Journey',
  // `LiveActivityIntent` -- the "Got it" button -- is iOS 17. Everything else
  // the widget draws works from 16.2, but a button the rider cannot press
  // without unlocking is not the get-off alert this feature exists to be.
  deploymentTarget: '17.0',
  frameworks: ['SwiftUI', 'WidgetKit', 'ActivityKit', 'AppIntents'],
  colors: {
    // The app's brand blue, from the splash screen.
    $accent: '#208AEF',
  },
};
