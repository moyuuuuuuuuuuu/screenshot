export type QuotaOperation = 'ocr' | 'translate';

export type QuotaConsumption = Readonly<{
  accepted: boolean;
  remaining: number;
  resetsAt: string;
}>;

export type QuotaStatus = Readonly<{
  ocr: Readonly<{ limit: 20; remaining: number }>;
  translate: Readonly<{ limit: 10; remaining: number }>;
  resetsAt: string;
}>;

export interface QuotaStore {
  consume(
    deviceId: string,
    operation: QuotaOperation,
    nowMilliseconds: number,
  ): Promise<QuotaConsumption>;
  status(deviceId: string, nowMilliseconds: number): Promise<QuotaStatus>;
}
