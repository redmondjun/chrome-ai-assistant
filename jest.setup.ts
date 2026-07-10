// jest.setup.ts
// Mock chrome APIs using jest
import { TextDecoder, TextEncoder } from 'util';

global.chrome = {
  runtime: {
    onMessage: { addListener: jest.fn(), removeListener: jest.fn() },
    sendMessage: jest.fn(),
    onInstalled: { addListener: jest.fn() },
    openOptionsPage: jest.fn(),
    lastError: null,
  },
  tabs: {
    query: jest.fn(),
    sendMessage: jest.fn(),
    onActivated: { addListener: jest.fn(), removeListener: jest.fn() },
    onUpdated: { addListener: jest.fn(), removeListener: jest.fn() },
  },
  storage: {
    sync: { get: jest.fn(), set: jest.fn(), remove: jest.fn() },
    onChanged: { addListener: jest.fn() },
  },
  sidePanel: {
    setPanelBehavior: jest.fn(),
    setOptions: jest.fn(),
  },
  scripting: {
    executeScript: jest.fn(),
  },
} as any;

Object.assign(global, { TextDecoder, TextEncoder });
Object.defineProperty(Element.prototype, 'scrollIntoView', {
  writable: true,
  value: jest.fn(),
});

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: jest.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

// Mock IndexedDB
global.indexedDB = {
  open: jest.fn(),
} as any;

// Mock crypto.randomUUID
Object.defineProperty(global, 'crypto', {
  value: {
    randomUUID: () => 'test-uuid-' + Math.random().toString(36).substr(2, 9),
  },
});
