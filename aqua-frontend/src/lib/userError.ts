/* What an error may say on screen (2026-10-28).

   The server now sends a sentence for engine failures (aqua/src/routes/
   envelope.js publicErrorMessage). This is the second line: an older server,
   another route, or a thrown JS error must still not put a router chain
   ("All providers exhausted | task=simple_qa | chain=groq:…"), a provider
   name, a stack frame, a driver error or a key fragment in a chat bubble or a
   toast. A guard's own sentence ("You're out of credits.") passes through. */

const INTERNAL_ERROR = new RegExp(
  [
    'exhausted', '\\btask=', '\\bchain=', '\\b(?:groq|gemini|openrouter|nvidia|openai|anthropic|mistral)\\b',
    '\\bat [\\w.<>$]+ \\(', '\\b(?:Type|Reference|Syntax|Range)Error\\b', 'Cannot read propert', 'is not a function',
    '\\bE(?:CONN\\w+|TIMEDOUT|NOTFOUND|AI_AGAIN)\\b', '\\bMongo\\w*Error', '\\bE11000\\b', 'duplicate key', 'violates',
    'relation "', '\\bSQL\\b', '\\bpostgres', '\\bsk-[\\w-]{6,}', '\\bgsk_', '\\bAIza', '\\bBearer\\s', 'Request failed with status code',
  ].join('|'),
  'i',
);

export const GENERIC_ERROR = 'Something went wrong. Please try again.';

/** A server or thrown message if it is fit for a person to read; otherwise `fallback`. */
export function userErrorMessage(raw: unknown, fallback: string = GENERIC_ERROR): string {
  const s = String(raw ?? '').trim();
  if (!s || s.length > 300 || INTERNAL_ERROR.test(s)) return fallback;
  return s;
}
