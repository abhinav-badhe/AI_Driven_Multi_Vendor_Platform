import { describe, it, expect } from 'vitest';
import { App } from '../src/App';

describe('App Shell', () => {
  it('should be defined as a component function', () => {
    expect(typeof App).toBe('function');
  });
});
