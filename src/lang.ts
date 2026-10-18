// Languages of what testers write for you. English always; a second language is optional (app.yaml
// second_language: ar, or --second-language ar): every thought, finding and message then comes in both, and the
// video and reports show both lines (right-to-left where the language needs it).
export type Lang2 = { code: string; name: string; rtl: boolean };

const NAMES: Record<string, string> = {
  ar: "Arabic", fr: "French", es: "Spanish", de: "German", pt: "Portuguese", it: "Italian", nl: "Dutch", tr: "Turkish",
  ru: "Russian", hi: "Hindi", ur: "Urdu", fa: "Persian", he: "Hebrew", zh: "Chinese", ja: "Japanese", ko: "Korean",
};
const RTL = new Set(["ar", "he", "fa", "ur"]);

/** The second language from a code like "ar", or undefined for English only ("" / "none" / "en" / missing). */
export function lang2(code?: string | null): Lang2 | undefined {
  const c = code?.trim().toLowerCase();
  if (!c || c === "none" || c === "en") return undefined;
  return { code: c, name: NAMES[c] ?? c, rtl: RTL.has(c) };
}

/** Finding labels in the second language, where we have them (shown as "Bad UI · واجهة ماشي مزيانة"). */
export const KIND_LABELS_2: Record<string, Record<string, string>> = {
  ar: { issue: "مشكل", bad_ux: "تجربة صعيبة", bad_ui: "واجهة ماشي مزيانة", idea: "فكرة زوينة", language: "اللغة", praise: "عجبني" },
};

/** "Waiting for the team…" in the second language, where we have it. */
export const WAITING_2: Record<string, string> = { ar: "كنتسنى الجواب ديالهم…" };
