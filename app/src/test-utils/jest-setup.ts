import { jest } from '@jest/globals';

// Native modules with no JavaScript fallback, replaced by each library's own
// Jest mock. `jest.mock` factories are hoisted above imports, so they have to
// use `require`.
/* eslint-disable @typescript-eslint/no-require-imports */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'));
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
