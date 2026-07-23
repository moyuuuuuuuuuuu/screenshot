import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('desktop stylesheet', () => {
  it('contains no selectors for removed service result components', () => {
    const stylesheet = readFileSync('src/styles.css', 'utf8');

    expect(stylesheet).not.toMatch(/\.service-busy\b/);
    expect(stylesheet).not.toMatch(/\.service-result\b/);
  });

  it('visibly distinguishes disabled and terminating sidecar actions', () => {
    const stylesheet = readFileSync('src/styles.css', 'utf8');

    expect(stylesheet).toMatch(
      /\.scroll-sidecar__actions button:disabled\s*\{[^}]*opacity:\s*0\.\d+;[^}]*cursor:\s*not-allowed;[^}]*transform:\s*scale\([^)]*\);[^}]*\}/s,
    );
    expect(stylesheet).toMatch(
      /\.scroll-sidecar\[data-terminating="true"\] \.scroll-sidecar__actions button:disabled\s*\{[^}]*cursor:\s*wait;[^}]*\}/s,
    );
  });
});
