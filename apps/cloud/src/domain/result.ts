import { z } from 'zod';

export type TextBlock = Readonly<{
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type RecognitionResult = Readonly<{
  sourceLanguage: 'zh' | 'en';
  originalText: string;
  translatedText: string | null;
  blocks: readonly TextBlock[];
}>;

const normalizedCoordinateSchema = z.number().min(0).max(1);

export const textBlockSchema = z
  .object({
    text: z.string(),
    x: normalizedCoordinateSchema,
    y: normalizedCoordinateSchema,
    width: normalizedCoordinateSchema,
    height: normalizedCoordinateSchema,
  })
  .strict()
  .refine(({ x, width }) => x + width <= 1, {
    message: 'Text block must fit within normalized horizontal bounds.',
  })
  .refine(({ y, height }) => y + height <= 1, {
    message: 'Text block must fit within normalized vertical bounds.',
  });

export const recognitionResultSchema = z
  .object({
    sourceLanguage: z.enum(['zh', 'en']),
    originalText: z.string(),
    translatedText: z.string().nullable(),
    blocks: z.array(textBlockSchema),
  })
  .strict();
