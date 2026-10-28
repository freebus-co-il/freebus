import { requireOptionalNativeModule } from 'expo-modules-core';

import type { LiveSurface } from '@/features/journey/live-surface';

/**
 * The ActivityKit bridge, typed by the contract it exists to satisfy.
 *
 * The app does not import this: `src/features/journey/live-surface.ts` resolves
 * the same module by name and wraps it in the no-op fallback every caller
 * actually uses. This file is the module's own entry point, and it earns its
 * place by pinning the native surface to `LiveSurface` at the boundary -- the
 * one spot where a Swift signature and a TypeScript one can be made to disagree
 * loudly at compile time rather than quietly at runtime.
 *
 * Null off iOS, and on any build predating the native module.
 */
export default requireOptionalNativeModule<LiveSurface>('LiveJourney');
