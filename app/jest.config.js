// Component tests: `*.test.tsx`, rendered with React Native Testing Library
// under jest-expo. Plain logic tests stay `*.test.ts` on `node --test`
// (see package.json), which is faster and needs no React Native runtime.
/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/src/**/*.test.tsx'],
  moduleNameMapper: {
    '^@/assets/(.*)$': '<rootDir>/assets/$1',
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  setupFiles: ['<rootDir>/src/test-utils/jest-setup.ts'],
  setupFilesAfterEnv: ['<rootDir>/src/test-utils/jest-after-env.ts'],
};
