/**
 * The ONE error envelope every non-2xx response in this service uses.
 *
 * Before this existed the API shipped three different error bodies —
 * `@fastify/sensible`'s `{statusCode, error, message}` on most routes,
 * `{error: "snake_case_code", ...}` on `/plan`'s 422/503, and
 * `{ready, state}` on `/ready`'s 503 — so a client could not write one
 * parser. Everything now serialises as:
 *
 * ```json
 * {
 *   "statusCode": 422,
 *   "code": "date_outside_service_window",
 *   "message": "The loaded feed covers 20260821 to 20260920; 20261201 is outside it.",
 *   "requestId": "req-3",
 *   "details": { "serviceWindow": { "start": 20260821, "end": 20260920 } }
 * }
 * ```
 *
 * `code` is the machine-readable half and is what a client should branch on;
 * `message` is for humans and may change wording at any time. `details` is
 * optional and its shape is documented per `code`. `requestId` is the
 * Fastify request id, echoed on every error so a report of a 500 can be
 * matched to the server-side log line that has the real cause (which is
 * deliberately NOT in the body — see `server.ts`'s error handler).
 *
 * `/ready`'s 200 body (`{ready, state}`) is a SUCCESS body and is unaffected;
 * only its 503 uses this shape.
 */
export interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
  requestId: string;
  details?: Record<string, unknown>;
}

/**
 * An intentional, client-facing error: the status, the machine-readable
 * code, and the human message are all deliberate and all safe to serve.
 * Anything thrown that is NOT one of these is treated as an internal fault
 * by the error handler and never has its message shown to a client.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  readonly headers: Record<string, string> | undefined;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    opts: {
      details?: Record<string, unknown>;
      headers?: Record<string, string>;
    } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = opts.details;
    this.headers = opts.headers;
  }
}

/**
 * The fallback `code` for an error that carries a status but no code of its
 * own — a `@fastify/sensible` `httpErrors.badRequest`, a schema validation
 * failure, a rate-limit rejection. Derived from the status so the code space
 * stays snake_case and closed, rather than leaking Fastify's own
 * `FST_ERR_*` identifiers into the public contract.
 */
const CODE_BY_STATUS: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  406: "not_acceptable",
  409: "conflict",
  413: "payload_too_large",
  414: "uri_too_long",
  415: "unsupported_media_type",
  422: "unprocessable_entity",
  429: "rate_limited",
  500: "internal_error",
  502: "bad_gateway",
  503: "service_unavailable",
  504: "gateway_timeout",
};

export function codeForStatus(status: number): string {
  return CODE_BY_STATUS[status] ?? (status >= 500 ? "internal_error" : "request_failed");
}

/**
 * Public `code` for a PRE-ROUTER framework error.
 *
 * Fastify raises a handful of errors before routing happens at all — a URL
 * component that is not valid percent-encoding, a path parameter past
 * `maxParamLength` — and those never reach `setErrorHandler`, because there
 * is no route yet to handle them for. Left alone, Fastify answers them with
 * its OWN built-in body, which is both the old three-key shape and a leak of
 * the internal `FST_ERR_*` identifier:
 *
 *   {"error":"Bad Request","code":"FST_ERR_MAX_PARAM_LENGTH","message":"…","statusCode":414}
 *
 * `server.ts` intercepts them via Fastify's `frameworkErrors` option and
 * routes them through this, so they arrive in the same envelope as
 * everything else. The `FST_ERR_*` identifier is TRANSLATED here, never
 * passed through: it is an internal name whose stability is Fastify's
 * business, not part of this API's contract. Anything not named here falls
 * back to the status-derived code, so a future framework error added by a
 * Fastify upgrade still cannot leak its identifier.
 */
const CODE_BY_FRAMEWORK_ERROR: Record<string, string> = {
  FST_ERR_BAD_URL: "bad_url",
  FST_ERR_MAX_PARAM_LENGTH: "uri_too_long",
};

export function codeForFrameworkError(
  frameworkCode: string | undefined, status: number,
): string {
  return (frameworkCode === undefined ? undefined : CODE_BY_FRAMEWORK_ERROR[frameworkCode])
    ?? codeForStatus(status);
}
