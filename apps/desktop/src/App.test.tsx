import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App', () => {
  it('renders the screenshot overlay', () => {
    render(<App />);

    expect(screen.getByLabelText('截图编辑器')).toBeInTheDocument();
  });
});
