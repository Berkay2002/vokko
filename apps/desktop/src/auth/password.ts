// Password strength feedback for the sign-up and change-password forms. The server has the final word
// (account/rules.rs: 8-128 chars, not common, at least 4 distinct characters, no username or email name inside).

export type Strength = 0 | 1 | 2 | 3 | 4;

export const WEAK_PASSWORD = "Password is too weak or common to use.";

const COMMON = new Set([
  "password", "password1", "password12", "password123", "12345678", "123456789", "1234567890", "qwertyuiop", "qwerty123", "11111111", "00000000",
  "iloveyou", "sunshine", "princess", "football", "baseball", "superman", "trustno1", "letmein1", "welcome1", "admin123", "abc12345", "abcd1234",
  "1q2w3e4r", "1qaz2wsx", "zaq12wsx", "passw0rd", "p@ssw0rd", "qwerty12", "asdfghjkl", "starwars", "whatever", "dragon12", "monkey12",
  "87654321", "12341234", "11223344", "a1b2c3d4", "changeme", "vokko123", "discord1", "discord123",
]);

/** The message the server would answer with, or null when the password passes its rules. */
export function passwordProblem(password: string, personal: string[] = []): string | null {
  const length = [...password].length;
  if (length < 8 || length > 128) return "Must be between 8 and 128 in length.";
  const lower = password.toLowerCase();
  const distinct = new Set(lower).size;
  const personalHit = personal.map(value => value.split("@")[0]?.toLowerCase() ?? "").some(value => value.length >= 3 && lower.includes(value));
  if (COMMON.has(lower) || distinct < 4 || personalHit) return WEAK_PASSWORD;
  return null;
}

/** 0 = rejected, 1 weak, 2 fair, 3 good, 4 strong. */
export function passwordStrength(password: string, personal: string[] = []): Strength {
  if (passwordProblem(password, personal)) return 0;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter(re => re.test(password)).length;
  const length = [...password].length;
  let score = 1;
  if (length >= 12) score += 1;
  if (length >= 16) score += 1;
  if (classes >= 3) score += 1;
  return Math.min(4, score) as Strength;
}

export const STRENGTH_LABELS = ["Too weak", "Weak", "Fair", "Good", "Strong"] as const;
