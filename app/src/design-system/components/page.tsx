import { router, Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useColors } from '../theme';
import { Layout, Space } from '../tokens';
import { glyphFor, type IconName } from './icon';
import { IconButton } from './icon-button';
import { Text } from './text';

/** A tab root's large title, in content (tab roots have no native header). */
export function PageTitle({ children, style }: { children: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.pageTitle, style]}>
      <Text variant="largeTitle" accessibilityRole="header">
        {children}
      </Text>
    </View>
  );
}

export type HeaderAction = {
  icon: IconName;
  accessibilityLabel: string;
  onPress: () => void;
};

/**
 * Turns on the native stack header for a pushed screen: system back button,
 * inline title, and actions -- a glass toolbar capsule on iOS 26, plain icon
 * buttons in a Material top app bar on Android. Render it at the top of the page.
 *
 * Solid (`bgGrouped`) by default, so content starts below it with no inset
 * bookkeeping. `transparent` is for a page whose content is a map.
 */
export function NativeHeader({ title, actions = [], transparent = false }: { title?: string; actions?: HeaderAction[]; transparent?: boolean }) {
  const colors = useColors();
  const ios = Platform.OS === 'ios';
  const { t } = useTranslation();
  // A deep link straight into a pushed page has no history to pop, and the
  // native header then shows no back button at all: give it a way home.
  const orphan = !router.canGoBack();
  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: title ?? '',
          headerTransparent: transparent,
          headerShadowVisible: false,
          headerBackButtonDisplayMode: 'minimal',
          headerTintColor: colors.textPrimary,
          headerTitleStyle: { color: colors.textPrimary },
          headerStyle: transparent ? undefined : { backgroundColor: colors.bgGrouped },
          headerTitleAlign: ios ? 'center' : 'left',
          headerLeft: orphan
            ? () => (
                <IconButton
                  icon="chevronBack"
                  accessibilityLabel={t('common.back')}
                  onPress={() => router.replace('/')}
                  variant="plain"
                />
              )
            : undefined,
          headerRight:
            !ios && actions.length > 0
              ? () => (
                  <View style={styles.androidActions}>
                    {actions.map((action) => (
                      <IconButton key={action.icon} variant="plain" {...action} />
                    ))}
                  </View>
                )
              : undefined,
        }}
      />
      {ios && actions.length > 0 && (
        <Stack.Toolbar placement="right">
          {actions.map((action) => (
            <Stack.Toolbar.Button
              key={action.icon}
              icon={glyphFor(action.icon).ios}
              accessibilityLabel={action.accessibilityLabel}
              onPress={action.onPress}
            />
          ))}
        </Stack.Toolbar>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  pageTitle: { paddingHorizontal: Layout.pageInset, paddingTop: Space.sm, paddingBottom: Space.lg },
  androidActions: { flexDirection: 'row', gap: Space.xs },
});
