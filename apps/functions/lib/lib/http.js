import { ApiError } from './errors.js';
export function asyncHandler(fn) {
    return (req, res, next) => {
        fn(req, res, next).catch(next);
    };
}
export function errorMiddleware(err, _req, res, _next) {
    if (err instanceof ApiError) {
        res.status(err.status).json({ error: { code: err.code, message: err.message } });
        return;
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: { code: 'INTERNAL', message } });
}
