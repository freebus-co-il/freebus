import { isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Appearance, Platform } from 'react-native';

import { useColorScheme } from '@/hooks/use-color-scheme';

import { Palettes, type Palette } from './tokens';

export type Scheme = 'light' | 'dark';

/** The scheme the app paints in: the rider's override, else the device's. */
export function useScheme(): Scheme {
  return useColorScheme() === 'dark' ? 'dark' : 'light';
}

/** The colour roles for the current scheme. */
export function useColors(): Palette {
  return Palettes[useScheme()];
}

/**
 * Pushes the in-app light/dark choice down to the native layer, so native tabs,
 * headers, sheets, menus, date pickers and Liquid Glass follow it rather than the
 * phone's setting. `'device'` hands control back to the system.
 */
export function applyColorSchemeOverride(preference: 'device' | 'light' | 'dark') {
  Appearance.setColorScheme(preference === 'device' ? 'unspecified' : preference);
}

function useAccessibilityFlag(
  read: () => Promise<boolean>,
  event: 'reduceTransparencyChanged' | 'reduceMotionChanged',
): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    read().then((value) => live && setOn(value)).catch(() => {});
    const sub = AccessibilityInfo.addEventListener(event, setOn);
    return () => {
      live = false;
      sub.remove();
    };
  }, [read, event]);
  return on;
}

export function useReduceTransparency(): boolean {
  return useAccessibilityFlag(AccessibilityInfo.isReduceTransparencyEnabled, 'reduceTransparencyChanged');
}

export function useReduceMotion(): boolean {
  return useAccessibilityFlag(AccessibilityInfo.isReduceMotionEnabled, 'reduceMotionChanged');
}

/** Liquid Glass is drawable: iOS 26+, the API present (some 26 betas lacked it). */
export const GLASS_SUPPORTED: boolean =
  Platform.OS === 'ios' && isLiquidGlassAvailable() && isGlassEffectAPIAvailable();

/** Glass should be drawn right now: supported, and not turned down by the rider. */
export function useGlassEnabled(): boolean {
  const reduce = useReduceTransparency();
  return GLASS_SUPPORTED && !reduce;
}
