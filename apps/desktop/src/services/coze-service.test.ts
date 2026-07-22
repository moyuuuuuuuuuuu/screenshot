import { describe, expect, it, vi } from 'vitest';
import { createCozeService, CozeServiceError } from './coze-service';

const config = { token: 'token-1', workflowId: 'workflow-1' };

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('CozeService', () => {
  it('does not upload screenshot pixels until a service is explicitly invoked', () => {
    const fetcher = vi.fn();
    createCozeService({ fetcher, getConfig: async () => config });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uploads the image then maps OCR workflow output', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ data: { id: 'file-1' } }))
      .mockResolvedValueOnce(response({ code: 0, data: JSON.stringify({ text: '你好' }) }));
    const service = createCozeService({ fetcher, getConfig: async () => config });

    await expect(service.ocr(new Blob(['png'], { type: 'image/png' }))).resolves.toEqual({ text: '你好' });
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'https://api.coze.cn/v1/files/upload',
      expect.objectContaining({ method: 'POST', headers: { Authorization: 'Bearer token-1' } }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://api.coze.cn/v1/workflow/run',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('forwards AbortSignal to upload and workflow requests', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    const service = createCozeService({ fetcher, getConfig: async () => config });

    controller.abort();
    await expect(service.translate(new Blob(), 'en', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: controller.signal }));
  });

  it('maps non-2xx and malformed workflow responses to typed errors', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ data: { id: 'file-1' } }))
      .mockResolvedValueOnce(response({ message: 'bad gateway' }, 502));
    const service = createCozeService({ fetcher, getConfig: async () => config });

    await expect(service.redact(new Blob())).rejects.toBeInstanceOf(CozeServiceError);
  });
});
