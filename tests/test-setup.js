import { vi, beforeEach, afterEach } from 'vitest';

// Mock window.__TAURI__ globals before main.js is loaded.
// The app uses withGlobalTauri: true, so it accesses APIs via window.__TAURI__.

const mockInvoke = vi.fn();
const mockOpen = vi.fn();
const mockGetCurrentWindow = vi.fn(() => ({
  onDragDropEvent: vi.fn(),
}));

class MockChannel {
  constructor() {
    this.onmessage = null;
  }
}

window.__TAURI__ = {
  core: {
    invoke: mockInvoke,
    Channel: MockChannel,
  },
  dialog: {
    open: mockOpen,
  },
  window: {
    getCurrentWindow: mockGetCurrentWindow,
  },
};

// Expose mocks for tests to configure
window.__mocks__ = {
  invoke: mockInvoke,
  open: mockOpen,
  getCurrentWindow: mockGetCurrentWindow,
};

// Track DOMContentLoaded handlers so we can remove them between tests
const registeredDCLHandlers = [];
const originalAddEventListener = window.addEventListener.bind(window);
window.addEventListener = function (type, handler, options) {
  if (type === 'DOMContentLoaded') {
    registeredDCLHandlers.push(handler);
  }
  return originalAddEventListener(type, handler, options);
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  // Remove accumulated DOMContentLoaded handlers
  for (const h of registeredDCLHandlers) {
    window.removeEventListener('DOMContentLoaded', h);
  }
  registeredDCLHandlers.length = 0;
  // Reset DOM body between tests
  document.body.innerHTML = '';
});
