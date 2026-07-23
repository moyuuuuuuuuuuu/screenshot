import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from './SettingsPanel';

describe('SettingsPanel', () => {
  it('records a combination, reports conflicts, and restores the default shortcut', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error('快捷键已被占用'));
    render(
      <SettingsPanel
        initialSettings={{
          shortcut: 'Alt+Shift+A',
          cloudPrivacyAcknowledged: false,
        }}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );

    const recorder = screen.getByRole('button', { name: '录制快捷键' });
    fireEvent.keyDown(recorder, { key: 'X', code: 'KeyX', ctrlKey: true, altKey: true });
    expect(recorder).toHaveTextContent('Ctrl+Alt+X');

    await userEvent.click(screen.getByRole('button', { name: '保存设置' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('快捷键已被占用');

    await userEvent.click(screen.getByRole('button', { name: '恢复默认快捷键' }));
    expect(recorder).toHaveTextContent('Alt+Shift+A');
  });

  it('contains no Coze token or workflow controls and saves only the shortcut', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <SettingsPanel
        initialSettings={{
          shortcut: 'Alt+Shift+A',
          cloudPrivacyAcknowledged: true,
        }}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText(/coze/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/token/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/workflow/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '保存设置' }));
    expect(onSave).toHaveBeenCalledWith('Alt+Shift+A');
  });
});
