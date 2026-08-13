/** Jest config: runs unit + e2e specs under test/ and src/, ts-jest transform. */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/test/**/*.spec.ts'],
  testTimeout: 20000,
  setupFiles: ['reflect-metadata'],
};
