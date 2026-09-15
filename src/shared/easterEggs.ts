// Message easter eggs (1.5): the pure half — "does this line deserve a bug
// running across the window, or confetti?".
//
// Detection is deliberately reader-side and wire-invisible: nothing about an
// egg travels in the envelope. Every client looks at the plain `body.text` of a
// `kind: 'text'` message and decides for itself, which means an older build
// simply shows nothing and a newer one can widen the vocabulary without a
// format bump. Keep it that way — an `egg` field in MsgBody would be a wire
// change for a joke.
//
// The team writes in four languages (English, French, German/Swiss German,
// Portuguese), so the vocabulary covers all four. Matching is
// accent-insensitive (NFD, drop the combining marks) and case-insensitive, so
// "Félicitations", "FELICITATIONS" and "felicitations" are one word, and
// Swiss-typed "Chaefer" lands next to "Chäfer".

export type EasterEgg = 'bug' | 'confetti'

/**
 * Lowercase, decomposed, marks dropped: the form every pattern below is
 * written in. "Glückwunsch" → "gluckwunsch", "parabéns" → "parabens".
 */
export function foldForMatch(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()
}

/**
 * Fenced code, including an unterminated fence someone is still typing. Both
 * markers markdown accepts: the backreference makes a fence close with the
 * marker it opened with, so `~~~` inside a ``` block is just text.
 */
const FENCE_RE = /(```|~~~)[\s\S]*?(?:\1|$)/g
/**
 * Inline code spans — `bug` in backticks is a symbol, not a complaint. Matched
 * as a *run* of backticks against an equal run, which is how markdown lets a
 * span contain a backtick: ``bug`` is one span, not two empty ones with a word
 * in between (that reading used to leak the word straight through).
 */
const INLINE_CODE_RE = /(`+)[^\n]*?\1/g
/**
 * Lines indented like a code block. Four spaces (or any tab depth) in front of
 * something is how pasted code arrives when nobody bothered with a fence.
 */
const INDENTED_CODE_RE = /^(?:[ ]{4,}|\t+)\S[^\n]*/gm
/**
 * Addresses. `bug@example.com` is where to send the report, not a report — and
 * the local part is exactly where a word like this shows up. A bare `@ana`
 * mention has nothing before the `@`, so it is left alone.
 */
const EMAIL_RE = /[^\s@]+@[^\s@]+/g
/**
 * Anything that looks like a link. Covers app schemes too (`sfgif://…`), so a
 * pasted URL with "bug" or "congrats" in its path stays silent. `www.` without
 * a scheme is how people actually paste domains.
 */
const URL_RE = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/gi
/**
 * A host pasted with neither scheme nor `www.` — `bugs.example.com/42`, which
 * is how a tracker link arrives half the time.
 *
 * The last label has to be a TLD this list names, and that restriction is the
 * whole design: a general "word.word" rule would eat a missing space after a
 * full stop ("great work.Congrats everyone") and silence a real celebration,
 * which is a worse failure than letting one tracker host through. Growing the
 * list is cheap; loosening the shape is not.
 */
const BARE_HOST_RE =
  /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.(?:com|net|org|edu|gov|int|io|dev|app|ai|co|me|info|xyz|tech|cloud|test|ch|de|fr|it|es|pt|br|uk|eu|nl|at|be|se|no|dk|fi|pl|ca|us)\b(?:\/\S*)?/gi

/**
 * Drop the parts of a message that are addresses or code rather than prose.
 * Runs on the raw text, before folding — nothing here depends on case or
 * accents, and stripping first keeps a URL's path out of the word stream.
 *
 * Indented lines go first, while the line structure is still intact: every
 * later pass replaces its match with a single space, which would join the
 * lines around it.
 */
export function stripNonProse(text: string): string {
  return text
    .replace(INDENTED_CODE_RE, ' ')
    .replace(FENCE_RE, ' ')
    .replace(INLINE_CODE_RE, ' ')
    .replace(EMAIL_RE, ' ')
    .replace(URL_RE, ' ')
    .replace(BARE_HOST_RE, ' ')
}

/**
 * Insects. `\b` on both sides is the whole trick: "debug", "buggy", "bugle",
 * "debugging" and "bogueado" all carry the letters and none of them are a bug
 * report.
 *
 * - `bug`/`bugs` — English, and the word French, German and Portuguese
 *   developers actually use.
 * - `bogue(s)` — the French word proper.
 * - `kafer`/`chafer` — Käfer (DE) and Chäfer (CH) after folding; the `ae`
 *   spellings are what a Swiss keyboard-less phone produces.
 */
const BUG_RE = /\b(?:bugs?|bogues?|kafer|kaefer|chafer|chaefer)\b/u

/**
 * Celebrations. Multi-word phrases allow any run of whitespace so a line break
 * between "happy" and "birthday" still counts.
 *
 * English: congrats, congratulation(s), happy birthday.
 * French: felicitation(s), bravo, joyeux/bon/bonne anniversaire.
 * German + Swiss German: gratulation(en), gratuliere, (herzlichen)
 *   gluckwunsch(e), alles gute/guete zum geburtstag, happy birthday.
 * Portuguese: parabens, felicidades, feliz aniversario.
 */
const CONFETTI_RE = new RegExp(
  [
    '\\bcongrats\\b',
    '\\bcongratulations?\\b',
    '\\bhappy\\s+birthday\\b',
    '\\bfelicitations?\\b',
    '\\bbravos?\\b',
    '\\b(?:joyeux|bon|bonne)\\s+anniversaire\\b',
    '\\bgratulation(?:en)?\\b',
    '\\bgratuliere\\b',
    '\\bgluckwunsche?\\b',
    '\\balles\\s+gu[e]?te\\s+zum\\s+geburtstag\\b',
    '\\bparabens\\b',
    '\\bfelicidades\\b',
    '\\bfeliz\\s+aniversario\\b',
  ].join('|'),
  'u',
)

/**
 * Which animation this message earns, or null for the overwhelming majority
 * that earn none.
 *
 * Confetti wins a tie ("we fixed the bug — congrats!"): the celebration is the
 * point of that sentence, and playing both would break the one-at-a-time rule
 * the queue enforces anyway.
 */
export function detectEasterEgg(text: string): EasterEgg | null {
  if (!text) return null
  const folded = foldForMatch(stripNonProse(text))
  if (CONFETTI_RE.test(folded)) return 'confetti'
  if (BUG_RE.test(folded)) return 'bug'
  return null
}
