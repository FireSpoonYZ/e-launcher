import type { AskUserAnswer, AskUserQuestion } from './native';

export type QuestionDraft =
  | {kind: 'option'; answer: string}
  | {kind: 'multi'; selected: string[]}
  | {kind: 'custom'; answer: string};

export function selectQuestionOption(question: AskUserQuestion, draft: QuestionDraft | undefined, label: string): QuestionDraft | undefined {
  if (!question.multiSelect) return {kind: 'option', answer: label};
  const selected = new Set(draft?.kind === 'multi' ? draft.selected : []);
  if (selected.has(label)) selected.delete(label); else selected.add(label);
  const ordered = question.options.map(option => option.label).filter(option => selected.has(option));
  return ordered.length ? {kind: 'multi', selected: ordered} : undefined;
}

export function activateCustomAnswer(draft: QuestionDraft | undefined): QuestionDraft {
  return draft?.kind === 'custom' ? draft : {kind: 'custom', answer: ''};
}

export function setCustomAnswer(answer: string): QuestionDraft {
  return {kind: 'custom', answer};
}

export function buildQuestionnaireAnswers(questions: AskUserQuestion[], drafts: Partial<Record<number, QuestionDraft>>): AskUserAnswer[] {
  const answers: AskUserAnswer[] = [];
  for (const question of questions) {
    const draft = drafts[question.questionIndex];
    if (!draft || (draft.kind === 'custom' && !draft.answer.trim()) || (draft.kind === 'multi' && !draft.selected.length)) continue;
    if (draft.kind === 'option') answers.push({questionIndex: question.questionIndex, kind: 'option', answer: draft.answer});
    else if (draft.kind === 'multi') answers.push({questionIndex: question.questionIndex, kind: 'multi', selected: draft.selected});
    else answers.push({questionIndex: question.questionIndex, kind: 'custom', answer: draft.answer});
  }
  return answers;
}
