export type QuotaOperation = 'ocr' | 'translate';

export type QuotaConsumption = Readonly<{
  accepted: boolean;
  remaining: number;
  resetsAt: string;
}>;

export interface QuotaStore {
  consume(
    deviceId: string,
    operation: QuotaOperation,
    nowMilliseconds: number,
  ): Promise<QuotaConsumption>;
}
