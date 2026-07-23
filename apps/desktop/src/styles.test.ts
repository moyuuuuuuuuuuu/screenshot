import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('desktop stylesheet', () => {
  it('contains no selectors for removed service result components', () => {
    const stylesheet = readFileSync('src/styles.css', 'utf8');

    expect(stylesheet).not.toMatch(/\.service-busy\b/);
    expect(stylesheet).not.toMatch(/\.service-result\b/);
  });
});
