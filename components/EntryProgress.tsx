import { Check } from "lucide-react";
import { t, type Language } from "@/lib/i18n";

export function EntryProgress({ language, step }: { language: Language; step: 1 | 2 | 3 }) {
  const steps = ["stepLanguage", "stepName", "stepRoom"] as const;
  return (
    <ol className="entry-progress">
      {steps.map((key, index) => (
        <li key={key} aria-current={step === index + 1 ? "step" : undefined} className={index + 1 < step ? "is-complete" : ""}>
          <span className="entry-step-number" aria-hidden="true">{index + 1 < step ? <Check /> : index + 1}</span>
          {t(language, key)}
        </li>
      ))}
    </ol>
  );
}
