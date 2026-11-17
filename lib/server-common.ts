// Request abstraction in the style of t-lib-backend/server/server-common.ts: handlers receive an
// IncomingHttpRequest and return a JSON-serializable value, or a RawResponse for XML and other bodies.

export interface IncomingHttpRequest {
    body: any | null;
    queryStringParameters: {[key: string]: string};
    headers: {[key: string]: string};
    pathParameters: {[key: string]: string};
    sourceIp?: string;
    // Headers the handler wants set on the response, applied by the Express wrapper.
    responseHeaders?: {[name: string]: string};
    // Status code for successful responses (default 200).
    responseStatus?: number;
}

// A handler result that is sent as-is instead of being JSON-encoded.
export class RawResponse {
    constructor(public body: string, public contentType: string) {}
}

export const time = {
    now: () => new Date(),
};
