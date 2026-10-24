import { isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Appearance, Platform } from 'react-native';

import { useColorScheme } from '@/hooks/use-color-scheme';

import { Palettes, type Palette } from './tokens';

export type Scheme = 'light' | 'dark';

const SchemeOverride = createContext<Scheme | null>(null);

/**
 * Paints everything under it in `scheme` rather than the app's: colours,
 * text, icons and glass all read `useScheme`. For a part of the app whose
 * backdrop is not the app's own, which is a map pinned light or dark in
 * settings: chrome made for a dark page turns unreadable on a light map.
 */
export function SchemeScope({ scheme, children }: { scheme: Scheme; children: ReactNode }) {
  return createElement(SchemeOverride.Provider, { value: scheme }, children);
}

/** The scheme to paint in: the nearest `SchemeScope`'s, else the app's (the
 *  rider's override, else the device's). */
export function useScheme(): Scheme {
  const override = useContext(SchemeOverride);
  const app = useColorScheme() === 'dark' ? 'dark' : 'light';
  return override ?? app;
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
