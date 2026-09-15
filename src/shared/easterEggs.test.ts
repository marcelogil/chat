import { describe, expect, it } from 'vitest'
import { detectEasterEgg, foldForMatch, stripNonProse } from './easterEggs'

// The vocabulary, language by language, plus the negatives that matter more
// than any of them: a team of developers types "debug" and "buggy" all day, and
// an insect crawling across the window every time would stop being a joke
// within an hour.

describe('detectEasterEgg — English', () => {
  it('finds bugs', () => {
    expect(detectEasterEgg('we found a bug in prod')).toBe('bug')
    expect(detectEasterEgg('two bugs left before we ship')).toBe('bug')
    expect(detectEasterEgg('BUG!')).toBe('bug')
    expect(detectEasterEgg('is that a bug?')).toBe('bug')
  })

  it('finds celebrations', () => {
    expect(detectEasterEgg('congrats!')).toBe('confetti')
    expect(detectEasterEgg('Congratulations on the release')).toBe('confetti')
    expect(detectEasterEgg('happy birthday Maria')).toBe('confetti')
    expect(detectEasterEgg('Happy   Birthday!!')).toBe('confetti')
  })
})

describe('detectEasterEgg — French', () => {
  it('finds bugs', () => {
    expect(detectEasterEgg('il y a un bug dans le build')).toBe('bug')
    expect(detectEasterEgg('encore une bogue')).toBe('bug')
    expect(detectEasterEgg('deux bogues à corriger')).toBe('bug')
  })

  it('finds celebrations, accents or not', () => {
    expect(detectEasterEgg('félicitations !')).toBe('confetti')
    expect(detectEasterEgg('FELICITATIONS')).toBe('confetti')
    expect(detectEasterEgg('bravo tout le monde')).toBe('confetti')
    expect(detectEasterEgg('joyeux anniversaire Luc')).toBe('confetti')
    expect(detectEasterEgg('bon anniversaire !')).toBe('confetti')
  })
})

describe('detectEasterEgg — German and Swiss German', () => {
  it('finds bugs', () => {
    expect(detectEasterEgg('Da ist ein Bug im Build')).toBe('bug')
    expect(detectEasterEgg('Ein Käfer im Code')).toBe('bug')
    expect(detectEasterEgg('Da hät s en Chäfer')).toBe('bug')
    expect(detectEasterEgg('chaefer gfunde')).toBe('bug')
  })

  it('finds celebrations', () => {
    expect(detectEasterEgg('Gratulation!')).toBe('confetti')
    expect(detectEasterEgg('ich gratuliere dir')).toBe('confetti')
    expect(detectEasterEgg('Herzlichen Glückwunsch zum Release')).toBe('confetti')
    expect(detectEasterEgg('Alles Gute zum Geburtstag')).toBe('confetti')
    expect(detectEasterEgg('Alles Guete zum Geburtstag!')).toBe('confetti')
    expect(detectEasterEgg('happy birthday Hans')).toBe('confetti')
  })
})

describe('detectEasterEgg — Portuguese', () => {
  it('finds bugs', () => {
    expect(detectEasterEgg('tem um bug na produção')).toBe('bug')
  })

  it('finds celebrations', () => {
    expect(detectEasterEgg('Parabéns!')).toBe('confetti')
    expect(detectEasterEgg('PARABENS pessoal')).toBe('confetti')
    expect(detectEasterEgg('felicidades a todos')).toBe('confetti')
    expect(detectEasterEgg('feliz aniversário, João')).toBe('confetti')
  })
})

describe('detectEasterEgg — negatives', () => {
  it('never fires inside a longer word', () => {
    for (const s of [
      'debug the thing',
      'debugging all morning',
      'that code is buggy',
      'he played the bugle',
      'foi bogueado',
      'Bugatti',
      'kafkaesque',
      'bravour',
      'congratulatory note',
    ]) {
      expect(detectEasterEgg(s)).toBeNull()
    }
  })

  it('stays silent for ordinary messages', () => {
    expect(detectEasterEgg('')).toBeNull()
    expect(detectEasterEgg('lunch at 12?')).toBeNull()
    expect(detectEasterEgg('the build is green')).toBeNull()
  })

  it('ignores fenced code blocks, even unterminated ones', () => {
    expect(detectEasterEgg('look:\n```js\nconst bug = 1\n```\nnothing to see')).toBeNull()
    expect(detectEasterEgg('```\nlet congrats = true\n')).toBeNull()
    // Prose around a block still counts.
    expect(detectEasterEgg('a bug:\n```\nlet x = 1\n```')).toBe('bug')
  })

  it('ignores tilde fences as well as backtick ones', () => {
    expect(detectEasterEgg('~~~\nconst bug = 1\n~~~')).toBeNull()
    expect(detectEasterEgg('~~~js\nlet congrats = true\n')).toBeNull()
    // A fence closes with the marker it opened with, so this is one block.
    expect(detectEasterEgg('```\n~~~ bug ~~~\n```')).toBeNull()
    expect(detectEasterEgg('a bug:\n~~~\nlet x = 1\n~~~')).toBe('bug')
  })

  it('ignores inline code spans', () => {
    expect(detectEasterEgg('call `bug()` please')).toBeNull()
    expect(detectEasterEgg('the flag is `congrats`')).toBeNull()
  })

  it('ignores a span delimited by a run of backticks', () => {
    // Two-backtick spans are how markdown writes a span containing a backtick;
    // reading them as two empty spans used to leave the word in the open.
    expect(detectEasterEgg('``bug``')).toBeNull()
    expect(detectEasterEgg('the value is ```congrats``` today')).toBeNull()
    expect(detectEasterEgg('a bug in ``x`y`` there')).toBe('bug')
  })

  it('ignores lines indented like code', () => {
    expect(detectEasterEgg('    const bug = 1')).toBeNull()
    expect(detectEasterEgg('\tlet congrats = true')).toBeNull()
    expect(detectEasterEgg('here:\n    if (bug) fix()')).toBeNull()
    // Three spaces is a typo, not a code block.
    expect(detectEasterEgg('   a bug')).toBe('bug')
  })

  it('ignores email addresses', () => {
    expect(detectEasterEgg('mail bug@example.com')).toBeNull()
    expect(detectEasterEgg('write to congrats@team.io')).toBeNull()
    // An @mention is not an address, and the prose around it still counts.
    expect(detectEasterEgg('@ana congrats!')).toBe('confetti')
  })

  it('ignores a host pasted without a scheme', () => {
    expect(detectEasterEgg('see bugs.example.com for details')).toBeNull()
    expect(detectEasterEgg('congrats.example.co.uk/x is the page')).toBeNull()
    // But a missing space after a full stop is prose, not a host.
    expect(detectEasterEgg('great work.Congrats everyone')).toBe('confetti')
    expect(detectEasterEgg('found it.bug is in the parser')).toBe('bug')
  })

  it('ignores URLs', () => {
    expect(detectEasterEgg('https://bugs.example.com/bug/12 has the details')).toBeNull()
    expect(detectEasterEgg('see www.example.com/congrats')).toBeNull()
    expect(detectEasterEgg('sfgif://pack/bug.gif')).toBeNull()
    // The visible half of a markdown link is prose, the target is not.
    expect(detectEasterEgg('[the bug](https://example.com/x)')).toBe('bug')
  })
})

describe('detectEasterEgg — precedence', () => {
  it('lets the celebration win when a line carries both', () => {
    expect(detectEasterEgg('we fixed the bug — congrats!')).toBe('confetti')
  })
})

describe('helpers', () => {
  it('folds accents and case into one form', () => {
    expect(foldForMatch('Félicitations')).toBe('felicitations')
    expect(foldForMatch('Glückwunsch')).toBe('gluckwunsch')
    expect(foldForMatch('Parabéns')).toBe('parabens')
    expect(foldForMatch('Käfer')).toBe('kafer')
    // Pre-composed and decomposed input fold the same way.
    expect(foldForMatch('é')).toBe(foldForMatch('é'))
  })

  it('replaces code and links with a space rather than joining words', () => {
    expect(stripNonProse('a`x`b').trim()).toBe('a b')
    expect(stripNonProse('one https://x.test/y two')).toBe('one   two')
  })
})
