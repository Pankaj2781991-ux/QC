import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import { fileTypeFromBuffer } from 'file-type';
import { parseBuffer as parseAudioBuffer } from 'music-metadata';

import type { QcNormalizedInput } from '@qc/qc-engine';

export type DetectedInputType = 'text' | 'json' | 'csv' | 'xlsx' | 'audio' | 'unknown';

export async function detectInputType(buffer: Buffer, fileName?: string, contentType?: string): Promise<DetectedInputType> {
  const lower = (fileName ?? '').toLowerCase();
  if (contentType?.startsWith('audio/')) return 'audio';
  if (lower.endsWith('.xlsx')) return 'xlsx';
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.txt')) return 'text';

  const ft = await fileTypeFromBuffer(buffer);
  if (ft?.mime?.startsWith('audio/')) return 'audio';
  if (ft?.mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx';
  if (ft?.mime === 'application/json') return 'json';
  if (ft?.mime?.startsWith('text/')) return 'text';

  return 'unknown';
}

export function normalizeInlineJson(value: unknown): QcNormalizedInput {
  if (typeof value === 'string') {
    return { kind: 'text', text: value };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { kind: 'record', record: value as Record<string, unknown> };
  }
  return { kind: 'record', record: { value } };
}

export async function normalizeFromBuffer(input: {
  buffer: Buffer;
  fileName?: string;
  contentType?: string;
}): Promise<QcNormalizedInput> {
  const type = await detectInputType(input.buffer, input.fileName, input.contentType);

  switch (type) {
    case 'text': {
      return { kind: 'text', text: input.buffer.toString('utf8') };
    }
    case 'json': {
      const text = input.buffer.toString('utf8');
      const parsed = JSON.parse(text);
      return normalizeInlineJson(parsed);
    }
    case 'csv': {
      const text = input.buffer.toString('utf8');
      const parsed = Papa.parse<Record<string, unknown>>(text, { header: true, skipEmptyLines: true });
      const rows = parsed.data ?? [];
      const columns = parsed.meta.fields ?? [];
      return { kind: 'table', columns, rows };
    }
    case 'xlsx': {
      const workbook = new ExcelJS.Workbook();
      // ExcelJS typings lag behind newer Node Buffer generics; runtime accepts Buffer.
      await workbook.xlsx.load(input.buffer as unknown as any);
      const sheet = workbook.worksheets[0];
      if (!sheet) return { kind: 'table', columns: [], rows: [] };

      const headerRow = sheet.getRow(1);
      const columns: string[] = [];
      headerRow.eachCell((cell, colNumber) => {
        const v = cell.value;
        columns[colNumber - 1] = v === null || v === undefined ? '' : String(v).trim();
      });

      const rows: Record<string, unknown>[] = [];
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const obj: Record<string, unknown> = {};
        row.eachCell((cell, colNumber) => {
          const key = columns[colNumber - 1] || `col_${colNumber}`;
          const raw = cell.value as any;
          obj[key] = raw?.text ?? raw;
        });
        rows.push(obj);
      });

      return { kind: 'table', columns: columns.filter((c) => c.length > 0), rows };
    }
    case 'audio': {
      const meta = await parseAudioBuffer(input.buffer, input.contentType ? { mimeType: input.contentType } : undefined);
      const durationSec = meta.format.duration ?? 0;
      return { kind: 'audio', durationMs: Math.max(0, Math.round(durationSec * 1000)), format: meta.format.container ?? undefined };
    }
    default: {
      // Safe fallback: treat as UTF-8 text.
      return { kind: 'text', text: input.buffer.toString('utf8') };
    }
  }
}
