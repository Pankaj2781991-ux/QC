export type QcPublicErrorCategory = 'VALIDATION' | 'INTEGRATION' | 'EXECUTION' | 'RULE_EVALUATION';

export type QcPublicError = {
  category: QcPublicErrorCategory;
  code: string;
  message: string;
  help?: string;
  retryable: boolean;
};

export function asPublicError(input: {
  category: QcPublicErrorCategory;
  code: string;
  message: string;
  help?: string;
  retryable: boolean;
}): QcPublicError {
  return {
    category: input.category,
    code: input.code,
    message: input.message,
    ...(input.help ? { help: input.help } : {}),
    retryable: input.retryable
  };
}

export function unknownExecutionError(): QcPublicError {
  return asPublicError({
    category: 'EXECUTION',
    code: 'EXECUTION_UNKNOWN',
    message: 'The run could not be completed due to an internal processing error.',
    help: 'Try again. If the issue persists, contact support with the run ID.',
    retryable: true
  });
}
