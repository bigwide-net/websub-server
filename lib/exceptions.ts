// Subset of t-lib-backend/server/exceptions.ts (mono repo), plus websub-specific errors.

export class HttpError extends Error {
    constructor(public name: string, public statusCode: number, message: string, public extraData?: any,
                public headers?: Record<string, string>) {
        super(message);
    }
}

export class NotFoundError extends HttpError {
    constructor(public message: string) {
        super('NotFound', 404, message);
    }
}

export class InvalidRequestError extends HttpError {
    constructor(public message: string) {
        super('InvalidRequest', 400, message);
    }
}

export class InternalError extends HttpError {
    constructor(public message: string) {
        super('Internal', 500, message);
    }
}

// A limit (subscriptions per feed or callback host) is reached.
export class LimitReachedError extends HttpError {
    constructor(public message: string) {
        super('LimitReached', 409, message);
    }
}

export class TooManyRequestsError extends HttpError {
    constructor(public message: string, retryAfterSeconds: number) {
        const retryAfter = Math.max(1, Math.ceil(retryAfterSeconds));
        super('RateLimited', 429, message, { retryAfter }, { 'Retry-After': String(retryAfter) });
    }
}

// Too many pending verifications. Subscribers should retry later.
export class BusyError extends HttpError {
    constructor() {
        super('Busy', 503, 'Too many pending requests. Please try again later.');
    }
}
