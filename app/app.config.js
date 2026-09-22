// The Android Maps key is NOT committed. A build without it gets a blank
// basemap and no error, which is the single most confusing failure in this
// app, so the value is required rather than defaulted.
const androidMapsApiKey = process.env.EXPO_PUBLIC_ANDROID_MAPS_KEY;

module.exports = {
  expo: {
    name: "FreeBus",
    slug: "freebus",
    version: "1.0.0",
    orientation: "portrait",
    icon: "./assets/images/icon.png",
    scheme: "freebus",
    userInterfaceStyle: "automatic",
    ios: {
      bundleIdentifier: "il.co.freebus",
      icon: "./assets/expo.icon",
      infoPlist: {
        NSSupportsLiveActivities: true,
        NSLocationWhenInUseUsageDescription: "FreeBus uses your location to set your starting point for trip planning.",
        NSLocationAlwaysAndWhenInUseUsageDescription: "FreeBus follows your journey in the background so it can wake you in time to get off.",
        UIBackgroundModes: [
          "location",
          "processing"
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
      "./modules/live-journey/app.plugin.js"
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
    owner: "sagishalom",
    runtimeVersion: {
      policy: "appVersion"
    },
    updates: {
      url: "https://u.expo.dev/48516aee-b137-401c-83a2-122fbdb7578f"
    }
  }
};
