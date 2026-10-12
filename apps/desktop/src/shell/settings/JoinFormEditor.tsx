import { Plus, X } from "lucide-react";
import type { MemberVerificationField, MemberVerificationForm } from "../../api/types";
import { Category } from "./controls";

type QuestionType = "TEXT_INPUT" | "PARAGRAPH" | "MULTIPLE_CHOICE";
export interface Question {
  key: number;
  type: QuestionType;
  label: string;
  required: boolean;
  choices: string[];
}
export interface FormDraft {
  description: string;
  rules: string[];
  questions: Question[];
}

const MAX_QUESTIONS = 5;
const MAX_CHOICES = 8;
const MAX_RULES = 16;
const TYPE_LABELS: Record<QuestionType, string> = { TEXT_INPUT: "Short answer", PARAGRAPH: "Paragraph", MULTIPLE_CHOICE: "Multiple choice" };
let nextKey = 1;

export function formDraft(form: MemberVerificationForm): FormDraft {
  const terms = form.form_fields.find(f => f.field_type === "TERMS");
  return {
    description: form.description ?? "",
    rules: terms?.values ?? [],
    questions: form.form_fields.filter((f): f is MemberVerificationField & { field_type: QuestionType } => f.field_type !== "TERMS").map(f => ({ key: nextKey++, type: f.field_type, label: f.label, required: f.required, choices: f.values ?? [] })),
  };
}

/** The canonical form for the PUT body (also what draft and stored form are compared by). */
export function formFromDraft(draft: FormDraft): MemberVerificationForm {
  const rules = draft.rules.map(r => r.trim()).filter(Boolean);
  const fields: MemberVerificationField[] = [];
  if (rules.length > 0) fields.push({ field_type: "TERMS", label: "Server Rules", required: true, values: rules });
  for (const q of draft.questions) {
    const field: MemberVerificationField = { field_type: q.type, label: q.label.trim(), required: q.required };
    if (q.type === "MULTIPLE_CHOICE") field.values = q.choices.map(c => c.trim()).filter(Boolean);
    fields.push(field);
  }
  return { description: draft.description.trim() || null, form_fields: fields };
}

/** Apply to Join form: description, the rules applicants must accept, and up to 5 questions (Discord's "Applications" setup). */
export function JoinFormEditor({ draft, onChange, disabled }: { draft: FormDraft; onChange(next: FormDraft): void; disabled?: boolean }) {
  const patch = (next: Partial<FormDraft>) => onChange({ ...draft, ...next });
  const setRule = (i: number, value: string) => patch({ rules: draft.rules.map((r, j) => (j === i ? value : r)) });
  const setQuestion = (key: number, next: Partial<Question>) => patch({ questions: draft.questions.map(q => (q.key === key ? { ...q, ...next } : q)) });
  return (
    <Category title="Applications">
      <div className="jf-editor">
        <label className="field-label" htmlFor="jf-description">
          Description (optional)
        </label>
        <textarea id="jf-description" className="input" rows={2} maxLength={300} disabled={disabled} value={draft.description} onChange={e => patch({ description: e.target.value })} />

        <div className="field-label">Server Rules</div>
        {draft.rules.map((rule, i) => (
          <div key={i} className="jf-row">
            <input className="input" aria-label={`Rule ${i + 1}`} maxLength={300} disabled={disabled} value={rule} onChange={e => setRule(i, e.target.value)} />
            <button type="button" className="btn btn-link btn-sm" aria-label={`Remove rule ${i + 1}`} disabled={disabled} onClick={() => patch({ rules: draft.rules.filter((_, j) => j !== i) })}>
              <X size={16} aria-hidden />
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || draft.rules.length >= MAX_RULES} onClick={() => patch({ rules: [...draft.rules, ""] })}>
          <Plus size={14} aria-hidden /> Add a rule
        </button>

        <div className="field-label">Questions ({draft.questions.length}/{MAX_QUESTIONS})</div>
        {draft.questions.map((q, n) => (
          <div key={q.key} className="jf-question" role="group" aria-label={`Question ${n + 1}`}>
            <div className="jf-row">
              <input className="input" aria-label={`Question ${n + 1} label`} placeholder="Question" maxLength={300} disabled={disabled} value={q.label} onChange={e => setQuestion(q.key, { label: e.target.value })} />
              <select className="input" aria-label={`Question ${n + 1} type`} disabled={disabled} value={q.type} onChange={e => setQuestion(q.key, { type: e.target.value as QuestionType, choices: e.target.value === "MULTIPLE_CHOICE" && q.choices.length === 0 ? [""] : q.choices })}>
                {(Object.keys(TYPE_LABELS) as QuestionType[]).map(t => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>
            {q.type === "MULTIPLE_CHOICE" && (
              <div className="jf-choices">
                {q.choices.map((c, i) => (
                  <div key={i} className="jf-row">
                    <input className="input" aria-label={`Question ${n + 1} choice ${i + 1}`} maxLength={150} disabled={disabled} value={c} onChange={e => setQuestion(q.key, { choices: q.choices.map((x, j) => (j === i ? e.target.value : x)) })} />
                    <button type="button" className="btn btn-link btn-sm" aria-label={`Remove choice ${i + 1}`} disabled={disabled} onClick={() => setQuestion(q.key, { choices: q.choices.filter((_, j) => j !== i) })}>
                      <X size={16} aria-hidden />
                    </button>
                  </div>
                ))}
                <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || q.choices.length >= MAX_CHOICES} onClick={() => setQuestion(q.key, { choices: [...q.choices, ""] })}>
                  <Plus size={14} aria-hidden /> Add a choice
                </button>
              </div>
            )}
            <div className="jf-row">
              <label className="apply-check">
                <input type="checkbox" disabled={disabled} checked={q.required} onChange={e => setQuestion(q.key, { required: e.target.checked })} /> Required
              </label>
              <button type="button" className="btn btn-link btn-sm" disabled={disabled} onClick={() => patch({ questions: draft.questions.filter(x => x.key !== q.key) })}>
                Remove question
              </button>
            </div>
          </div>
        ))}
        <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || draft.questions.length >= MAX_QUESTIONS} onClick={() => patch({ questions: [...draft.questions, { key: nextKey++, type: "TEXT_INPUT", label: "", required: true, choices: [] }] })}>
          <Plus size={14} aria-hidden /> Add a question
        </button>
      </div>
    </Category>
  );
}
