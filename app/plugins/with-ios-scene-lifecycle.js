// Adopts the UIScene lifecycle on iOS.
//
// An app built with the iOS 27 SDK that still uses the app-delegate window
// (no UIApplicationSceneManifest) is killed at launch on iOS 27: UIKit traps in
// `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`, before any
// JavaScript runs. Expo SDK 57's app delegate template creates its window in
// `didFinishLaunching`, so every build from Xcode 27 crashed on launch.
//
// This plugin moves window creation into a scene delegate:
//
// - Info.plist declares one window scene, served by `SceneDelegate`.
// - `AppDelegate` keeps the React Native factory and the launch options, and
//   no longer creates a window.
// - `SceneDelegate` creates the window from its scene and starts React Native
//   in it. A URL or user activity the app was cold-started with arrives in the
//   scene's connection options rather than the launch options, so it is put
//   back into the launch options React Native reads `getInitialURL` from.
// - URLs and user activities that arrive while running, and the four
//   foreground/background transitions, are forwarded to the app delegate,
//   because under the scene lifecycle UIKit stops calling it for them and Expo
//   modules subscribe to them there (`ExpoAppDelegateSubscriberManager`).
//
// The edit to AppDelegate.swift is a text replacement against Expo's template.
// If the template changes shape, prebuild fails here with a message rather
// than silently shipping an app that crashes on launch.

const { withAppDelegate, withInfoPlist } = require("expo/config-plugins");

const MARKER = "class SceneDelegate: UIResponder, UIWindowSceneDelegate";

const WINDOW_BLOCK =
  /#if os\(iOS\) \|\| os\(tvOS\)\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\s*factory\.startReactNative\(\s*withModuleName: "([^"]+)",\s*in: window,\s*launchOptions: launchOptions\)\s*#endif\n/;

const FACTORY_PROPERTY = "  var reactNativeFactory: RCTReactNativeFactory?\n";

function sceneDelegate(moduleName) {
  return `
/// Creates the app's window from its window scene and starts React Native in
/// it. See plugins/with-ios-scene-lifecycle.js for why this exists.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
          let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }

    // A cold start's URL or user activity comes with the scene, not with the
    // launch options; React Native reads the initial URL from the latter.
    var launchOptions = appDelegate.launchOptions ?? [:]
    if let url = connectionOptions.urlContexts.first?.url {
      launchOptions[.url] = url
    }
    if let activity = connectionOptions.userActivities.first {
      launchOptions[.userActivityDictionary] = [
        UIApplication.LaunchOptionsKey.userActivityType: activity.activityType,
        "UIApplicationLaunchOptionsUserActivityKey": activity,
      ]
    }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window
    appDelegate.reactNativeFactory?.startReactNative(
      withModuleName: "${moduleName}",
      in: window,
      launchOptions: launchOptions)
    window.makeKeyAndVisible()
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    for context in URLContexts {
      var options: [UIApplication.OpenURLOptionsKey: Any] = [:]
      if let source = context.options.sourceApplication {
        options[.sourceApplication] = source
      }
      _ = appDelegate.application(UIApplication.shared, open: context.url, options: options)
    }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    _ = appDelegate.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    (UIApplication.shared.delegate as? AppDelegate)?.applicationDidBecomeActive(UIApplication.shared)
  }

  func sceneWillResignActive(_ scene: UIScene) {
    (UIApplication.shared.delegate as? AppDelegate)?.applicationWillResignActive(UIApplication.shared)
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    (UIApplication.shared.delegate as? AppDelegate)?.applicationWillEnterForeground(UIApplication.shared)
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    (UIApplication.shared.delegate as? AppDelegate)?.applicationDidEnterBackground(UIApplication.shared)
  }
}
`;
}

/** The AppDelegate.swift source with the window moved into a scene delegate.
 *  Exported for testing; idempotent. */
function adoptSceneLifecycle(source) {
  if (source.includes(MARKER)) return source;
  const match = source.match(WINDOW_BLOCK);
  if (!match || !source.includes(FACTORY_PROPERTY)) {
    throw new Error(
      "with-ios-scene-lifecycle: AppDelegate.swift no longer matches the Expo template this plugin " +
        "edits. Update plugins/with-ios-scene-lifecycle.js for the new template; without it the app " +
        "crashes at launch on iOS 27.",
    );
  }
  return (
    source
      .replace(
        FACTORY_PROPERTY,
        FACTORY_PROPERTY +
          "  /// Kept for the scene delegate, which starts React Native once iOS hands\n" +
          "  /// it a window scene.\n" +
          "  var launchOptions: [UIApplication.LaunchOptionsKey: Any]?\n",
      )
      .replace(WINDOW_BLOCK, "    self.launchOptions = launchOptions\n") + sceneDelegate(match[1])
  );
}

/** Info.plist with the one window scene `SceneDelegate` serves. */
function withSceneManifest(infoPlist) {
  return {
    ...infoPlist,
    UIApplicationSceneManifest: {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
          },
        ],
      },
    },
  };
}

function withIosSceneLifecycle(config) {
  config = withInfoPlist(config, (mod) => {
    mod.modResults = withSceneManifest(mod.modResults);
    return mod;
  });
  return withAppDelegate(config, (mod) => {
    if (mod.modResults.language !== "swift") {
      throw new Error("with-ios-scene-lifecycle: expected a Swift AppDelegate.");
    }
    mod.modResults.contents = adoptSceneLifecycle(mod.modResults.contents);
    return mod;
  });
}

module.exports = withIosSceneLifecycle;
module.exports.adoptSceneLifecycle = adoptSceneLifecycle;
module.exports.withSceneManifest = withSceneManifest;
