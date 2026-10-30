import * as matchers from '@testing-library/jest-dom/matchers';
import { afterEach, expect } from 'vitest';
import { cleanup } from '@testing-library/react';
expect.extend(matchers);
afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});

// jsdom does not implement the native dialog lifecycle. Browser focus trapping is
// verified separately; these shims only let component tests exercise open/close.
Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
  configurable: true,
  value(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  },
});
Object.defineProperty(HTMLDialogElement.prototype, 'close', {
  configurable: true,
  value(this: HTMLDialogElement) {
    if (!this.open) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  },
});
