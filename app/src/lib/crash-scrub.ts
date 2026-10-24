import type { ErrorEvent } from '@sentry/react-native';

/**
 * What a crash report may carry, decided here and nowhere else.
 *
 * A report is for finding the line of code that broke. It must not say who
 * the rider is or where they are going, so everything that could is removed
 * before the report leaves the phone: the user (Sentry's native SDKs fill it
 * with a random installation id that persists across launches), the request,
 * breadcrumbs, `extra`, the server name, and every context outside the
 * allowlist below (no locale, timezone or device name).
 *
 * The exception message is kept, because "Cannot read property 'stops' of
 * undefined" is most of what makes a report useful, but it is scrubbed as
 * untrusted text: an error can quote a URL with coordinates in it, a JSON
 * body, or the text of a search. See `scrubText`.
 *
 * A pure module, with no React Native import, so it is tested under Node.
 */

/** Context fields kept, by context; a context missing here is dropped whole.
 *  `true` keeps every field: what is there describes the build, not the rider. */
const CONTEXT_ALLOWLIST: Record<string, readonly string[] | true> = {
  device: ['model', 'model_id', 'family', 'arch', 'simulator'],
  os: ['name', 'version', 'build'],
  app: ['app_version', 'app_build', 'app_identifier', 'in_foreground'],
  ota_updates: true,
  react_native_context: true,
};

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]+/gi;
const URL_PARTS = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)([^?#]*)/i;
// Runs of non-ASCII text, spaces between them included: in this app that is
// Hebrew, which means place names and search text, never code.
const NON_ASCII_RUN = /[^\x00-\x7F]+(?:\s+[^\x00-\x7F]+)*/g;
const QUOTED = /(['"`])([^'"`\n]*?)\1/g;
const CODE_IDENTIFIER = /^[A-Za-z_$][\w$.]{0,63}$/;
// A decimal, or a whole number of two digits or more: a stop id, a line
// number, a coordinate. A single digit ("index 3") says nothing about anyone.
const NUMBER = /\d+(?:\.\d+)+|\d{2,}/g;

/** Keeps the shape of a URL (its host, and its path with any segment that
 *  holds a digit replaced) and drops the query and fragment, which is where
 *  this app's requests carry coordinates. */
function scrubUrl(url: string): string {
  const match = URL_PARTS.exec(url);
  if (!match) return '…';
  const [, origin, path] = match;
  const segments = path.split('/').map((segment) => (/\d/.test(segment) ? ':id' : segment));
  return origin + segments.join('/');
}

/**
 * Scrubs free text for a report: URLs reduced to their shape, non-Latin
 * text removed, quoted strings kept only when they look like a code
 * identifier, and every number of two digits or more replaced with `#`.
 *
 * A single quoted Latin word ('stops') survives, since property and type
 * names are what a JavaScript error quotes. That is the one way a word
 * typed by a rider could get through, and only if code put it in an error.
 */
export function scrubText(text: string): string {
  return text
    .replace(URL_PATTERN, scrubUrl)
    .replace(NON_ASCII_RUN, '…')
    .replace(QUOTED, (whole, quote: string, inner: string) =>
      CODE_IDENTIFIER.test(inner) ? whole : `${quote}…${quote}`,
    )
    .replace(NUMBER, '#');
}

function scrubContexts(contexts: ErrorEvent['contexts']): ErrorEvent['contexts'] {
  if (!contexts) return undefined;
  const kept: NonNullable<ErrorEvent['contexts']> = {};
  for (const [name, context] of Object.entries(contexts)) {
    const allowed = CONTEXT_ALLOWLIST[name];
    if (!allowed || !context) continue;
    if (allowed === true) {
      kept[name] = context;
      continue;
    }
    const fields: Record<string, unknown> = {};
    for (const field of allowed) {
      if (field in context) fields[field] = context[field];
    }
    kept[name] = fields;
  }
  return kept;
}

/** `beforeSend`: the report, minus everything that is not about the code. */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const {
    user: _user,
    request: _request,
    breadcrumbs: _breadcrumbs,
    extra: _extra,
    server_name: _serverName,
    transaction: _transaction,
    ...rest
  } = event;

  const scrubbed: ErrorEvent = { ...rest, contexts: scrubContexts(event.contexts) };
  if (event.message !== undefined) scrubbed.message = scrubText(event.message);
  if (event.exception?.values) {
    scrubbed.exception = {
      ...event.exception,
      values: event.exception.values.map((exception) =>
        exception.value === undefined ? exception : { ...exception, value: scrubText(exception.value) },
      ),
    };
  }
  return scrubbed;
}
