import { isAbsolute, resolve } from 'node:path'

// Which profile directory this process runs against — the sealed LMK, every
// *.enc secret, the decrypted blob cache. This is not a cosmetic setting: a run
// that lands on the *default* profile and then onboards destroys the device
// identity living there (2026-09-14 — see CLAUDE.md, "Profiles and test runs").
//
// So: `CHAT_USER_DATA_DIR` is honoured in every build, packaged included. The
// old `SEMAPHORE_PROFILE` is deliberately left as it was — dev-only, derived
// from the default dir — because it is a two-instance convenience, not a safety
// belt; it silently did nothing in a packaged build, which is exactly how a
// packaged verification run ended up writing to a real person's profile.

/** Absolute path to the profile directory. Honoured in dev *and* packaged builds. */
export const USER_DATA_ENV = 'CHAT_USER_DATA_DIR'
/** Dev-only: suffixes the default dir so `dev:a`/`dev:b` can run side by side. */
export const PROFILE_ENV = 'SEMAPHORE_PROFILE'

export type UserDataSource = 'default' | 'profile' | 'override'

export interface UserDataResolution {
  /** The directory to hand `app.setPath('userData', …)`. */
  dir: string
  source: UserDataSource
  /**
   * Set when `CHAT_USER_DATA_DIR` was present but unusable; `dir` has fallen
   * back to what it would have been without it. Callers must treat this as
   * fatal rather than start: whoever set the variable did *not* want the
   * default profile, and quietly using it is the accident this exists to stop.
   */
  rejected: string | null
}

/**
 * Trailing separators and `.`/`..` segments are noise, not intent: compare and
 * return one normalized form. `resolve()` never consults the cwd for a path
 * that is already absolute, which is the only kind that gets this far.
 */
function normalizeDir(dir: string): string {
  return resolve(dir)
}

/**
 * Same folder? Compared case-insensitively on purpose: macOS and Windows both
 * ship case-insensitive filesystems by default, so `…/chat` and `…/Chat` are
 * one directory there. On a case-sensitive volume this can only ever refuse an
 * override that *differs from the real profile by case alone* — a scratch-dir
 * rename. The other direction costs someone their identity.
 */
function samePath(a: string, b: string): boolean {
  return normalizeDir(a).toLowerCase() === normalizeDir(b).toLowerCase()
}

/**
 * Decide the profile directory from the environment. Pure — no `app`, no fs, no
 * process globals — so the whole matrix is a unit test.
 *
 * Precedence: an explicit, valid `CHAT_USER_DATA_DIR` outranks everything;
 * otherwise `SEMAPHORE_PROFILE` in an unpackaged build; otherwise the default.
 */
export function resolveUserDataDir(input: {
  defaultDir: string
  env: Record<string, string | undefined>
  isPackaged: boolean
}): UserDataResolution {
  const { defaultDir, env, isPackaged } = input

  const profile = env[PROFILE_ENV]?.trim()
  const fallback: UserDataResolution =
    profile && !isPackaged
      ? { dir: `${normalizeDir(defaultDir)}-${profile}`, source: 'profile', rejected: null }
      : { dir: normalizeDir(defaultDir), source: 'default', rejected: null }

  const raw = env[USER_DATA_ENV]
  // Set-but-empty reads as not set, like every other env flag in this app.
  const wanted = raw?.trim()
  if (!wanted) return fallback

  const reject = (why: string): UserDataResolution => ({ ...fallback, rejected: why })

  if (!isAbsolute(wanted)) {
    return reject(`${USER_DATA_ENV} must be an absolute path (got ${JSON.stringify(raw)})`)
  }
  if (samePath(wanted, defaultDir)) {
    return reject(
      `${USER_DATA_ENV} points at the default profile (${normalizeDir(defaultDir)}) — ` +
        'that folder holds this device’s real identity; point it at a scratch directory instead',
    )
  }
  return { dir: normalizeDir(wanted), source: 'override', rejected: null }
}
