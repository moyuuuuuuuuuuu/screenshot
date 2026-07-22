import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EmojiPicker } from './EmojiPicker';

describe('EmojiPicker', () => {
  it('offers a consistent emoji palette and selects one', () => {
    const onSelect = vi.fn();
    render(<EmojiPicker onSelect={onSelect} />);

    expect(screen.getByRole('group', { name: '表情选择' })).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(12);
    fireEvent.click(screen.getByRole('button', { name: '微笑' }));
    expect(onSelect).toHaveBeenCalledWith('😊');
  });
});
