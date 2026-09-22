import { IconBusStop, IconHome, IconRoute, IconSettings } from '@tabler/icons-react-native';
import { Tabs } from 'expo-router';
import { BottomTabBar } from 'expo-router/js-tabs';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { JourneyBar } from '@/features/journey/journey-bar';
import { useTheme } from '@/hooks/use-theme';

/**
 * The places a rider can be when they are not inside a journey. Everything
 * else -- results, trip, station, line, the pickers -- is pushed by the ROOT
 * stack and covers this bar, so the tabs never compete with a screen that owns
 * the whole display.
 */
export default function TabsLayout() {
  const { t } = useTranslation();
  const theme = useTheme();

  return (
    <Tabs
      // Docked here rather than in a screen, because a running journey belongs
      // to no screen: this puts it on every tab, and under the root stack's
      // pushed screens, which is exactly where a now-playing bar lives.
      tabBar={(props) => (
        <View>
          <JourneyBar />
          <BottomTabBar {...props} />
        </View>
      )}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.text,
        tabBarInactiveTintColor: theme.textSecondary,
        // The page colour, so the bar is the bottom of the page rather than
        // a white ledge laid over it -- but a hairline on top, because the
        // page is white now and without one the last row of a list simply
        // stops in mid-air above the tabs. The same `borderMuted` line that
        // separates two rows, for the same reason: this is a divider, not
        // the edge of a control.
        //
        // `elevation: 0` stays. Android's default gives the bar a shadow,
        // which would draw that edge a second time and in a way the rest of
        // the app never does -- see AGENTS.md on shadows.
        tabBarStyle: {
          backgroundColor: theme.background,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: theme.borderMuted,
          elevation: 0,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t('tabs.home'),
          tabBarIcon: ({ color, size }) => <IconHome size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="lines"
        options={{
          title: t('tabs.lines'),
          tabBarIcon: ({ color, size }) => <IconRoute size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="stations"
        options={{
          title: t('tabs.stations'),
          tabBarIcon: ({ color, size }) => <IconBusStop size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t('tabs.settings'),
          tabBarIcon: ({ color, size }) => <IconSettings size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
