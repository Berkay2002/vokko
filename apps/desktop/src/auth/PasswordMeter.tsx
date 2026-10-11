import { STRENGTH_LABELS, passwordProblem, passwordStrength } from "./password";

/** Four bars plus a word, below a new-password input. Nothing while the field is empty. */
export function PasswordMeter({ password, personal }: { password: string; personal: string[] }) {
  if (!password) return null;
  const score = passwordStrength(password, personal);
  const problem = passwordProblem(password, personal);
  return (
    <div className={`auth-meter s${score}`} role="status" aria-live="polite">
      <div className="auth-meter-bars" aria-hidden="true">
        {[1, 2, 3, 4].map(i => (
          <span key={i} className={i <= score ? "on" : ""} />
        ))}
      </div>
      <span className="auth-meter-label">
        Password strength: {STRENGTH_LABELS[score]}
        {problem && ` - ${problem}`}
      </span>
    </div>
  );
}
