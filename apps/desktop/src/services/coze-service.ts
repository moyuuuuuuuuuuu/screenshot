import type { AppSettings } from '../bridge/desktop-bridge';

export type OcrResult = Readonly<{ text: string }>;
export type TranslationResult = Readonly<{ text: string; targetLanguage: string }>;
export type RedactionRegion = Readonly<{ x: number; y: number; width: number; height: number }>;

export interface CozeService {
  ocr(image: Blob, signal?: AbortSignal): Promise<OcrResult>;
  translate(image: Blob, targetLanguage: string, signal?: AbortSignal): Promise<TranslationResult>;
  redact(image: Blob, signal?: AbortSignal): Promise<RedactionRegion[]>;
}

export class CozeServiceError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'CozeServiceError';
  }
}

type CozeConfig = AppSettings['coze'];
type ServiceDependencies = Readonly<{
  fetcher?: typeof fetch;
  getConfig(): Promise<CozeConfig>;
  baseUrl?: string;
}>;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CozeServiceError('扣子返回了无效数据');
  }
  return value as Record<string, unknown>;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new CozeServiceError(`扣子请求失败 (${response.status})`, response.status);
  }
  try {
    return asRecord(await response.json());
  } catch (error) {
    if (error instanceof CozeServiceError) throw error;
    throw new CozeServiceError('扣子返回了无效 JSON');
  }
}

function parseWorkflowData(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.code !== undefined && payload.code !== 0) {
    throw new CozeServiceError(typeof payload.msg === 'string' ? payload.msg : '扣子工作流执行失败');
  }
  const data = payload.data;
  if (typeof data === 'string') {
    try {
      return asRecord(JSON.parse(data));
    } catch {
      throw new CozeServiceError('扣子工作流返回格式无效');
    }
  }
  return asRecord(data);
}

export function createCozeService({
  fetcher = fetch,
  getConfig,
  baseUrl = 'https://api.coze.cn',
}: ServiceDependencies): CozeService {
  const invoke = async (
    operation: 'ocr' | 'translate' | 'redact',
    image: Blob,
    targetLanguage?: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    const config = await getConfig();
    if (!config.token.trim() || !config.workflowId.trim()) {
      throw new CozeServiceError('请先在设置中填写 Coze Token 和 Workflow ID');
    }

    const form = new FormData();
    form.append('file', image, 'screenshot.png');
    const upload = await readJson(await fetcher(`${baseUrl}/v1/files/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}` },
      body: form,
      ...(signal ? { signal } : {}),
    }));
    const file = asRecord(upload.data);
    if (typeof file.id !== 'string') throw new CozeServiceError('扣子未返回文件 ID');

    const workflow = await readJson(await fetcher(`${baseUrl}/v1/workflow/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        workflow_id: config.workflowId,
        parameters: {
          operation,
          file_id: file.id,
          ...(targetLanguage ? { target_language: targetLanguage } : {}),
        },
      }),
      ...(signal ? { signal } : {}),
    }));
    return parseWorkflowData(workflow);
  };

  return {
    async ocr(image, signal) {
      const result = await invoke('ocr', image, undefined, signal);
      if (typeof result.text !== 'string') throw new CozeServiceError('OCR 结果缺少文本');
      return { text: result.text };
    },
    async translate(image, targetLanguage, signal) {
      const result = await invoke('translate', image, targetLanguage, signal);
      if (typeof result.text !== 'string') throw new CozeServiceError('翻译结果缺少文本');
      return { text: result.text, targetLanguage };
    },
    async redact(image, signal) {
      const result = await invoke('redact', image, undefined, signal);
      if (!Array.isArray(result.regions)) throw new CozeServiceError('隐私识别结果缺少区域');
      return result.regions.map((region) => {
        const value = asRecord(region);
        if (![value.x, value.y, value.width, value.height].every((item) => typeof item === 'number')) {
          throw new CozeServiceError('隐私区域格式无效');
        }
        return value as RedactionRegion;
      });
    },
  };
}
