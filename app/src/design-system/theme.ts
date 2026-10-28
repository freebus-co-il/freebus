import { isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Appearance, Platform } from 'react-native';

import { useColorScheme } from '@/hooks/use-color-scheme';

import { GlassPalettes, Palettes, type Palette } from './tokens';

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

const OnGlass = createContext(false);

/**
 * Marks everything under it as sitting on Liquid Glass, so `useColors` hands
 * out the glass inks (brighter secondary and tertiary text). `Glass` applies
 * it to its children; a glass drawn as a sibling backdrop (a sheet's
 * background) needs its content wrapped by hand. A no-op when glass is off:
 * the solid fallback keeps the solid inks.
 */
export function GlassInk({ children }: { children: ReactNode }) {
  const enabled = useGlassEnabled();
  if (!enabled) return children;
  return createElement(OnGlass.Provider, { value: true }, children);
}

/** The colour roles for the current scheme, and for glass if on it. */
export function useColors(): Palette {
  const scheme = useScheme();
  return useContext(OnGlass) ? GlassPalettes[scheme] : Palettes[scheme];
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
