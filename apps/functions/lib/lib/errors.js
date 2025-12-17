export class ApiError extends Error {
    code;
    status;
    constructor(code, message, status) {
        super(message);
        this.code = code;
        this.status = status;
        this.name = 'ApiError';
    }
}
export function assertNever(x, message) {
    throw new ApiError('INTERNAL', message, 500);
}
