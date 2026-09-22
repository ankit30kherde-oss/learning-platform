/** Separate from the unit-test jest block in package.json: e2e tests need a
 * real Postgres and Redis, take longer, and should never run as part of the
 * fast `pnpm test` loop a developer runs on every save. */
module.exports = {
  rootDir: 'test',
  testRegex: '.*\\.e2e-spec\\.ts$',
  transform: { '^.+\\.ts$': 'ts-jest' },
  testEnvironment: 'node',
  testTimeout: 20000,
  moduleFileExtensions: ['js', 'json', 'ts'],
};
