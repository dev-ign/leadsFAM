// Vitest 5 uses Matchers<R, T>; jest-dom's bundled adapter targets the older Assertion<T>.
import 'vitest';
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'vitest' {
  interface Matchers<R, T> extends TestingLibraryMatchers<T, R> {}
}
