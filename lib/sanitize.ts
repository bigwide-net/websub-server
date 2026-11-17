// Subset of rssmention/lib/sanitize.ts. Keep in sync.
//
// The hub only handles identifiers (URLs, tokens, secrets), never text meant for people: everything
// is reduced to printable ASCII or rejected.

// Plane noncharacters U+xFFFE and U+xFFFF of the supplementary planes 1-16.
const PLANE_NONCHARS = Array.from({ length: 16 }, (_, i) => {
    const p = (i + 1).toString(16).toUpperCase();
    return `\\u{${p}FFFE}\\u{${p}FFFF}`;
}).join('');

/**
 * Characters that never survive sanitizing (\t, \n and \r are handled separately):
 * C0 controls, DEL and C1 controls; soft hyphen; combining grapheme joiner; Mongolian vowel separator;
 * zero width space; LRM/RLM/ALM; bidi embeddings, overrides and isolates; word joiner and invisible
 * operators; deprecated format characters; BOM / zero width no-break space; interlinear annotation;
 * noncharacters; unpaired surrogates.
 */
const FORBIDDEN_SOURCE =
    '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u00AD\\u034F\\u061C\\u180E\\u200B\\u200E\\u200F' +
    '\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF\\uFFF9-\\uFFFB\\uFDD0-\\uFDEF\\uFFFE\\uFFFF' + PLANE_NONCHARS + ']|\\p{Cs}';
const FORBIDDEN_OR_CONTROL = new RegExp(FORBIDDEN_SOURCE + '|[\\t\\n\\r\\u2028\\u2029]', 'u');

/** True if the string contains a character that sanitizing would remove, or a line break or tab. */
export function hasForbiddenChars(s: string): boolean {
    return FORBIDDEN_OR_CONTROL.test(s);
}

/** True for non-empty strings of printable ASCII (space to ~) of at most `max` characters. */
export function isPrintableAscii(s: unknown, max: number): s is string {
    return typeof s == 'string' && s.length > 0 && s.length <= max && /^[\x20-\x7E]+$/.test(s);
}

/** Makes an untrusted value safe for a single log line: control, bidi and other invisible characters are escaped. */
export function escapeForLog(s: string): string {
    return s.replace(new RegExp(FORBIDDEN_SOURCE + '|[\\t\\n\\r\\u2028\\u2029]', 'gu'),
        c => `\\u{${c.codePointAt(0)!.toString(16)}}`);
}
