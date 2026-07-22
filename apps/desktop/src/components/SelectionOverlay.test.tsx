import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SelectionOverlay } from './SelectionOverlay';

describe('SelectionOverlay', () => {
  it('shows eight WeChat green handles and a movable size chip', () => {
    render(
      <SelectionOverlay
        selection={{ x: 20, y: 30, width: 100, height: 80 }}
        bounds={{ x: 0, y: 0, width: 300, height: 200 }}
        locked
        onSelectionChange={vi.fn()}
      />,
    );

    expect(document.querySelectorAll('.selection-handle[data-tone="wechat-green"]')).toHaveLength(8);
    expect(screen.getByTestId('selection-move-handle')).toHaveTextContent('100 × 80');
    expect(screen.getByTestId('selection-move-handle')).toHaveAttribute('data-placement', 'adaptive');
  });

  it('uses one full mask before a selection exists', () => {
    const { container } = render(
      <SelectionOverlay
        selection={null}
        bounds={{ x: 0, y: 0, width: 300, height: 200 }}
        onSelectionChange={vi.fn()}
      />,
    );

    expect(container.querySelectorAll('.selection-mask')).toHaveLength(1);
    expect(container.querySelector('.selection-mask--full')).toBeInTheDocument();
    expect(container.querySelector('[data-mask-side]')).not.toBeInTheDocument();
  });

  it('renders four non-overlapping masks around a selection', () => {
    const { container } = render(
      <SelectionOverlay
        selection={{ x: 20, y: 30, width: 100, height: 80 }}
        bounds={{ x: 0, y: 0, width: 300, height: 200 }}
        onSelectionChange={vi.fn()}
      />,
    );
    const mask = (side: string) => container.querySelector(`[data-mask-side="${side}"]`);

    expect(mask('top')).toHaveStyle({ left: '0px', top: '0px', width: '300px', height: '30px' });
    expect(mask('right')).toHaveStyle({ left: '120px', top: '30px', width: '180px', height: '80px' });
    expect(mask('bottom')).toHaveStyle({ left: '0px', top: '110px', width: '300px', height: '90px' });
    expect(mask('left')).toHaveStyle({ left: '0px', top: '30px', width: '20px', height: '80px' });
    expect(container.querySelectorAll('.selection-mask')).toHaveLength(4);
  });

  it('moves an existing selection without creating a new one', () => {
    const onSelectionChange = vi.fn();
    render(
      <SelectionOverlay
        selection={{ x: 20, y: 30, width: 100, height: 80 }}
        bounds={{ x: 0, y: 0, width: 300, height: 200 }}
        locked
        onSelectionChange={onSelectionChange}
      />,
    );

    const moveHandle = screen.getByTestId('selection-move-handle');
    fireEvent.pointerDown(moveHandle, { clientX: 40, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(moveHandle, { clientX: 70, clientY: 65, pointerId: 1 });
    fireEvent.pointerUp(moveHandle, { clientX: 70, clientY: 65, pointerId: 1 });

    expect(onSelectionChange).toHaveBeenLastCalledWith({
      x: 50,
      y: 45,
      width: 100,
      height: 80,
    });
  });

  it('resizes from a handle and preserves the opposite edge', () => {
    const onSelectionChange = vi.fn();
    render(
      <SelectionOverlay
        selection={{ x: 20, y: 30, width: 100, height: 80 }}
        bounds={{ x: 0, y: 0, width: 300, height: 200 }}
        locked
        onSelectionChange={onSelectionChange}
      />,
    );

    const handle = screen.getByTestId('selection-handle-se');
    fireEvent.pointerDown(handle, { clientX: 120, clientY: 110, pointerId: 2 });
    fireEvent.pointerMove(handle, { clientX: 150, clientY: 130, pointerId: 2 });
    fireEvent.pointerUp(handle, { clientX: 150, clientY: 130, pointerId: 2 });

    expect(onSelectionChange).toHaveBeenLastCalledWith({
      x: 20,
      y: 30,
      width: 130,
      height: 100,
    });
  });
});
