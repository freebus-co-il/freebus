// The Android Maps key is NOT committed. A build without it gets a blank
// basemap and no error, which is the single most confusing failure in this
// app, so the value is required rather than defaulted.
const androidMapsApiKey = process.env.EXPO_PUBLIC_ANDROID_MAPS_KEY;

// The store version lives in package.json alone, so the two cannot disagree.
// Bump it in any PR that changes native code: the "App release" check fails
// without it, and merging the bump to main ships a store build tagged
// `app-v<version>`. See "Releasing the app" in .github/CONTRIBUTING.md.
const { version } = require("./package.json");

module.exports = {
  expo: {
    name: "FreeBus",
    slug: "freebus",
    version,
    orientation: "portrait",
    icon: "./assets/images/icon.png",
    scheme: "freebus",
    userInterfaceStyle: "automatic",
    ios: {
      bundleIdentifier: "il.co.freebus",
      config: {
        usesNonExemptEncryption: false
      },
      icon: "./assets/expo.icon",
      infoPlist: {
        NSSupportsLiveActivities: true,
        NSLocationWhenInUseUsageDescription: "FreeBus uses your location to set your starting point for trip planning.",
        NSLocationAlwaysAndWhenInUseUsageDescription: "FreeBus follows your journey in the background so it can wake you in time to get off.",
        UIBackgroundModes: [
          "location"
        ]
      },
      entitlements: {
        "com.apple.developer.usernotifications.time-sensitive": true
      }
    },
    android: {
      package: "il.co.freebus",
      intentFilters: [
        {
          action: "VIEW",
          category: [
            "DEFAULT",
            "BROWSABLE"
          ],
          data: [
            {
              scheme: "geo"
            }
          ]
        }
      ],
      config: {
        googleMaps: {
          apiKey: androidMapsApiKey
        }
      },
      adaptiveIcon: {
        backgroundColor: "#000000",
        foregroundImage: "./assets/images/android-icon-foreground.png",
        monochromeImage: "./assets/images/android-icon-monochrome.png"
      },
      predictiveBackGestureEnabled: false,
      permissions: [
        "android.permission.ACCESS_COARSE_LOCATION",
        "android.permission.ACCESS_FINE_LOCATION",
        "android.permission.ACCESS_BACKGROUND_LOCATION",
        "android.permission.FOREGROUND_SERVICE",
        "android.permission.FOREGROUND_SERVICE_LOCATION",
        "android.permission.POST_NOTIFICATIONS",
        "android.permission.POST_PROMOTED_NOTIFICATIONS",
        "android.permission.VIBRATE"
      ]
    },
    web: {
      output: "static",
      favicon: "./assets/images/favicon.png"
    },
    plugins: [
      "expo-router",
      // Generates the open-source licence list (JS and native) shown from
      // Settings -> About & legal.
      "react-native-legal",
      [
        "expo-splash-screen",
        {
          backgroundColor: "#000000",
          image: "./assets/images/splash-icon.png",
          imageWidth: 100
        }
      ],
      [
        "expo-localization",
        {
          supportedLocales: {
            ios: ["he", "en"],
            android: ["he", "en"]
          }
        }
      ],
      [
        "expo-location",
        {
          locationWhenInUsePermission: "FreeBus uses your location to set your starting point for trip planning.",
          locationAlwaysAndWhenInUsePermission: "FreeBus follows your journey in the background so it can wake you in time to get off.",
          isAndroidBackgroundLocationEnabled: true,
          isIosBackgroundLocationEnabled: true
        }
      ],
      "@react-native-community/datetimepicker",
      [
        "expo-notifications",
        {
          icon: "./assets/images/notification-icon.png"
        }
      ],
      "@bacons/apple-targets",
      [
        "expo-share-intent",
        {
          iosShareExtensionName: "FreeBus Share",
          iosActivationRules: {
            NSExtensionActivationSupportsText: true,
            NSExtensionActivationSupportsWebURLWithMaxCount: 1,
            NSExtensionActivationSupportsWebPageWithMaxCount: 1
          },
          androidIntentFilters: [
            "text/*"
          ]
        }
      ],
      "./modules/live-journey/app.plugin.js",
      // Uploads source maps and debug symbols during the build, as
      // SENTRY_ORG / SENTRY_PROJECT with SENTRY_AUTH_TOKEN (EAS environment
      // variables). Until those exist, eas.json sets SENTRY_DISABLE_AUTO_UPLOAD
      // so a build skips the upload instead of failing on it.
      "@sentry/react-native/expo"
    ],
    experiments: {
      typedRoutes: true,
      reactCompiler: true
    },
    extra: {
      router: {},
      eas: {
        projectId: "48516aee-b137-401c-83a2-122fbdb7578f"
      }
    },
    owner: "freebus-co-il",
    // The fingerprint of everything native (see fingerprint.config.js), so
    // an OTA update only ever reaches binaries with the native code it was
    // written against. The deploy workflow uses the same fingerprint to choose
    // between an update and a store build: see .github/workflows/deploy-app.yml.
    // Never set this by hand: a hand-set value that a native change forgot to
    // bump sends that change's JavaScript to binaries without its native half.
    runtimeVersion: {
      policy: "fingerprint"
    },
    updates: {
      url: "https://u.expo.dev/48516aee-b137-401c-83a2-122fbdb7578f"
    }
  }
};
