import { z } from 'zod';

export const QC_ENGINE_VERSION = '0.1.0';

export const QcRuleTypeSchema = z.enum([
	'TEXT_REGEX',
	'TEXT_KEYWORD_BLACKLIST',
	'TEXT_REQUIRED_PHRASE',
	'NUMERIC_RANGE',
	'REQUIRED_FIELD',
	'EXCEL_ALL_CAPS',
	'EXCEL_REQUIRED_COLUMNS',
	'AUDIO_DURATION_LIMIT',
	'SLA_TIME_DIFFERENCE',
	// AI-assisted (never final authority; must use threshold logic)
	'TONE_CLASSIFICATION',
	'IMPLIED_ABUSE_DETECTION'
]);
export type QcRuleType = z.infer<typeof QcRuleTypeSchema>;

export const QcSeveritySchema = z.enum(['BLOCKER', 'MAJOR', 'MINOR', 'INFO']);
export type QcSeverity = z.infer<typeof QcSeveritySchema>;

export const EvidenceSchema = z.object({
	type: z.string().min(1),
	message: z.string().min(1),
	path: z.array(z.union([z.string(), z.number()])).optional(),
	meta: z.record(z.unknown()).optional()
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const QcNormalizedTextSchema = z.object({
	kind: z.literal('text'),
	text: z.string(),
	locale: z.string().optional()
});
export type QcNormalizedText = z.infer<typeof QcNormalizedTextSchema>;

export const QcNormalizedRecordSchema = z.object({
	kind: z.literal('record'),
	record: z.record(z.unknown())
});
export type QcNormalizedRecord = z.infer<typeof QcNormalizedRecordSchema>;

export const QcNormalizedTableSchema = z.object({
	kind: z.literal('table'),
	// For CSV/Excel normalization. `rows` may contain objects keyed by columns, or raw arrays.
	columns: z.array(z.string()).default([]),
	rows: z.array(z.unknown()).default([])
});
export type QcNormalizedTable = z.infer<typeof QcNormalizedTableSchema>;

export const QcNormalizedAudioSchema = z.object({
	kind: z.literal('audio'),
	durationMs: z.number().int().nonnegative(),
	format: z.string().optional()
});
export type QcNormalizedAudio = z.infer<typeof QcNormalizedAudioSchema>;

export const QcNormalizedInputSchema = z.discriminatedUnion('kind', [
	QcNormalizedTextSchema,
	QcNormalizedRecordSchema,
	QcNormalizedTableSchema,
	QcNormalizedAudioSchema
]);
export type QcNormalizedInput = z.infer<typeof QcNormalizedInputSchema>;

export const QcAiSignalSchema = z.object({
	ruleType: QcRuleTypeSchema,
	// Confidence is always provider-specific but must be in [0,1] for threshold logic.
	confidence: z.number().min(0).max(1),
	label: z.string().optional(),
	evidence: z.array(EvidenceSchema).default([]),
	provider: z.string().optional(),
	model: z.string().optional(),
	evaluatedAt: z.string().datetime().optional()
});
export type QcAiSignal = z.infer<typeof QcAiSignalSchema>;

export const QcAiSignalsSchema = z.object({
	tone: QcAiSignalSchema.optional(),
	impliedAbuse: QcAiSignalSchema.optional()
});
export type QcAiSignals = z.infer<typeof QcAiSignalsSchema>;

const RuleBaseSchema = z.object({
	ruleId: z.string().min(1),
	version: z.number().int().positive(),
	type: QcRuleTypeSchema,
	enabled: z.boolean().default(true),
	severity: QcSeveritySchema.default('MAJOR'),
	weight: z.number().min(0).max(1).default(1),
	name: z.string().min(1),
	description: z.string().optional(),
	tags: z.array(z.string()).default([])
});

export const TextRegexParamsSchema = z.object({
	fieldPath: z.array(z.string()).optional(),
	pattern: z.string().min(1),
	flags: z.string().optional(),
	mustMatch: z.boolean().default(true)
});
export type TextRegexParams = z.infer<typeof TextRegexParamsSchema>;

export const TextKeywordBlacklistParamsSchema = z.object({
	fieldPath: z.array(z.string()).optional(),
	keywords: z.array(z.string().min(1)).min(1),
	caseSensitive: z.boolean().default(false)
});
export type TextKeywordBlacklistParams = z.infer<typeof TextKeywordBlacklistParamsSchema>;

export const TextRequiredPhraseParamsSchema = z.object({
	fieldPath: z.array(z.string()).optional(),
	phrase: z.string().min(1),
	caseSensitive: z.boolean().default(false)
});
export type TextRequiredPhraseParams = z.infer<typeof TextRequiredPhraseParamsSchema>;

export const NumericRangeParamsSchema = z.object({
	fieldPath: z.array(z.string()).min(1),
	min: z.number().optional(),
	max: z.number().optional(),
	inclusiveMin: z.boolean().default(true),
	inclusiveMax: z.boolean().default(true)
});
export type NumericRangeParams = z.infer<typeof NumericRangeParamsSchema>;

export const RequiredFieldParamsSchema = z.object({
	fieldPath: z.array(z.string()).min(1),
	allowEmptyString: z.boolean().default(false)
});
export type RequiredFieldParams = z.infer<typeof RequiredFieldParamsSchema>;

export const ExcelAllCapsParamsSchema = z.object({
	column: z.string().min(1),
	minCapsRatio: z.number().min(0).max(1).default(1)
});
export type ExcelAllCapsParams = z.infer<typeof ExcelAllCapsParamsSchema>;

export const ExcelRequiredColumnsParamsSchema = z.object({
	requiredColumns: z.array(z.string().min(1)).min(1),
	caseSensitive: z.boolean().default(false)
});
export type ExcelRequiredColumnsParams = z.infer<typeof ExcelRequiredColumnsParamsSchema>;

export const AudioDurationLimitParamsSchema = z.object({
	maxDurationMs: z.number().int().positive()
});
export type AudioDurationLimitParams = z.infer<typeof AudioDurationLimitParamsSchema>;

export const SlaTimeDifferenceParamsSchema = z.object({
	startFieldPath: z.array(z.string()).min(1),
	endFieldPath: z.array(z.string()).min(1),
	maxDifferenceMs: z.number().int().positive()
});
export type SlaTimeDifferenceParams = z.infer<typeof SlaTimeDifferenceParamsSchema>;

export const ToneClassificationParamsSchema = z.object({
	// If confidence >= threshold AND label is in `failLabels`, it can fail.
	threshold: z.number().min(0).max(1),
	failLabels: z.array(z.string().min(1)).min(1)
});
export type ToneClassificationParams = z.infer<typeof ToneClassificationParamsSchema>;

export const ImpliedAbuseDetectionParamsSchema = z.object({
	threshold: z.number().min(0).max(1)
});
export type ImpliedAbuseDetectionParams = z.infer<typeof ImpliedAbuseDetectionParamsSchema>;

export const QcRuleDefinitionSchema = z.discriminatedUnion('type', [
	RuleBaseSchema.extend({ type: z.literal('TEXT_REGEX'), params: TextRegexParamsSchema }),
	RuleBaseSchema.extend({
		type: z.literal('TEXT_KEYWORD_BLACKLIST'),
		params: TextKeywordBlacklistParamsSchema
	}),
	RuleBaseSchema.extend({ type: z.literal('TEXT_REQUIRED_PHRASE'), params: TextRequiredPhraseParamsSchema }),
	RuleBaseSchema.extend({ type: z.literal('NUMERIC_RANGE'), params: NumericRangeParamsSchema }),
	RuleBaseSchema.extend({ type: z.literal('REQUIRED_FIELD'), params: RequiredFieldParamsSchema }),
	RuleBaseSchema.extend({ type: z.literal('EXCEL_ALL_CAPS'), params: ExcelAllCapsParamsSchema }),
	RuleBaseSchema.extend({
		type: z.literal('EXCEL_REQUIRED_COLUMNS'),
		params: ExcelRequiredColumnsParamsSchema
	}),
	RuleBaseSchema.extend({ type: z.literal('AUDIO_DURATION_LIMIT'), params: AudioDurationLimitParamsSchema }),
	RuleBaseSchema.extend({ type: z.literal('SLA_TIME_DIFFERENCE'), params: SlaTimeDifferenceParamsSchema }),
	RuleBaseSchema.extend({ type: z.literal('TONE_CLASSIFICATION'), params: ToneClassificationParamsSchema }),
	RuleBaseSchema.extend({
		type: z.literal('IMPLIED_ABUSE_DETECTION'),
		params: ImpliedAbuseDetectionParamsSchema
	})
]);
export type QcRuleDefinition = z.infer<typeof QcRuleDefinitionSchema>;

export const RuleOutcomeSchema = z.enum(['PASS', 'FAIL', 'SKIP', 'ERROR']);
export type RuleOutcome = z.infer<typeof RuleOutcomeSchema>;

export const QcRuleResultSchema = z.object({
	ruleId: z.string().min(1),
	version: z.number().int().positive(),
	type: QcRuleTypeSchema,
	severity: QcSeveritySchema,
	weight: z.number().min(0).max(1),
	outcome: RuleOutcomeSchema,
	score: z.number().min(0).max(1),
	evidence: z.array(EvidenceSchema).default([]),
	error: z
		.object({
			code: z.string().min(1),
			message: z.string().min(1)
		})
		.optional()
});
export type QcRuleResult = z.infer<typeof QcRuleResultSchema>;

export const QcRunSummarySchema = z.object({
	engineVersion: z.string().min(1),
	executedAt: z.string().datetime(),
	overallOutcome: z.enum(['PASS', 'FAIL']),
	overallScore: z.number().min(0).max(1),
	failedRuleIds: z.array(z.string()).default([])
});
export type QcRunSummary = z.infer<typeof QcRunSummarySchema>;

export const QcRunResultSchema = z.object({
	summary: QcRunSummarySchema,
	ruleResults: z.array(QcRuleResultSchema)
});
export type QcRunResult = z.infer<typeof QcRunResultSchema>;

export type QcExecutionContext = {
	input: QcNormalizedInput;
	aiSignals?: QcAiSignals;
	executedAtIso: string;
};

export type QcExecutionOptions = {
	passScoreThreshold?: number; // default: 1.0
	// If true, failing BLOCKER rules forces overall FAIL regardless of score threshold.
	blockerFailureForcesFail?: boolean; // default: true
};

export class QcRuleValidationError extends Error {
	public readonly code = 'QC_RULE_VALIDATION_ERROR';
	constructor(message: string) {
		super(message);
		this.name = 'QcRuleValidationError';
	}
}

export class QcExecutionError extends Error {
	public readonly code = 'QC_EXECUTION_ERROR';
	constructor(message: string) {
		super(message);
		this.name = 'QcExecutionError';
	}
}

export function getValueAtPath(record: unknown, path: string[]): unknown {
	let cursor: unknown = record;
	for (const key of path) {
		if (cursor === null || cursor === undefined) return undefined;
		if (typeof cursor !== 'object') return undefined;
		cursor = (cursor as Record<string, unknown>)[key];
	}
	return cursor;
}

export function asTextFromInput(input: QcNormalizedInput, fieldPath?: string[]): string | undefined {
	if (input.kind === 'text') return input.text;
	if (input.kind === 'record' && fieldPath?.length) {
		const value = getValueAtPath(input.record, fieldPath);
		if (typeof value === 'string') return value;
		return value === undefined || value === null ? undefined : String(value);
	}
	return undefined;
}
