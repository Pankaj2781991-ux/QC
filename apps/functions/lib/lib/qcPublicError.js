export function asPublicError(input) {
    return {
        category: input.category,
        code: input.code,
        message: input.message,
        ...(input.help ? { help: input.help } : {}),
        retryable: input.retryable
    };
}
export function unknownExecutionError() {
    return asPublicError({
        category: 'EXECUTION',
        code: 'EXECUTION_UNKNOWN',
        message: 'The run could not be completed due to an internal processing error.',
        help: 'Try again. If the issue persists, contact support with the run ID.',
        retryable: true
    });
}
