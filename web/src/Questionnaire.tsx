import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Eye, Pencil, X } from 'lucide-react';
import { Chat, type AskUserQuestionnaire, type QuestionnaireReply } from './native';
import { Markdown } from './Markdown';
import { ErrorNotice, errorText, useText } from './ui';
import { activateCustomAnswer, buildQuestionnaireAnswers, selectQuestionOption, setCustomAnswer, type QuestionDraft } from './questionnaireState';

export type QuestionnaireReplyEvent = QuestionnaireReply & {
  conversationId?: string;
  requestId?: string|null;
  sequence?: number;
};

export function Questionnaire({conversationId, requestId, questionnaire, reply}: {
  conversationId: string;
  requestId: string;
  questionnaire: AskUserQuestionnaire;
  reply?: QuestionnaireReplyEvent;
}) {
  const t = useText();
  const [current, setCurrent] = useState(0);
  const [drafts, setDrafts] = useState<Partial<Record<number, QuestionDraft>>>({});
  const [preview, setPreview] = useState<{label: string; markdown: string}>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const customInput = useRef<HTMLTextAreaElement>(null);
  const questions = questionnaire.questions;
  const question = questions[current];
  const draft = question && drafts[question.questionIndex];

  useEffect(() => {
    if (reply?.accepted !== false || reply.questionnaireId !== questionnaire.id
        || reply.conversationId !== conversationId || reply.requestId !== requestId) return;
    setPending(false);
    setError(reply.message || t('回答未被接受，请重试。', 'The answers were not accepted. Please try again.'));
  }, [reply, conversationId, requestId, questionnaire.id]);

  const cancel = async () => {
    if (pending) return;
    setError(''); setPending(true);
    try { await Chat.cancelQuestionnaire({conversationId, requestId, questionnaireId: questionnaire.id}); }
    catch (reason) { setPending(false); setError(errorText(reason)); }
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (preview) setPreview(undefined); else void cancel();
    };
    const composerBack = (event: Event) => {
      if (!preview) return;
      event.preventDefault(); setPreview(undefined);
    };
    const appBack = (event: Event) => {
      event.preventDefault();
      if (preview) setPreview(undefined); else void cancel();
    };
    document.addEventListener('keydown', key, true);
    window.addEventListener('composer-back', composerBack);
    window.addEventListener('app-back', appBack);
    return () => {
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('composer-back', composerBack);
      window.removeEventListener('app-back', appBack);
    };
  }, [preview, pending, conversationId, requestId, questionnaire.id]);

  if (!question) return null;
  const update = (next: QuestionDraft | undefined) => setDrafts(previous => {
    const changed = {...previous};
    if (next) changed[question.questionIndex] = next; else delete changed[question.questionIndex];
    return changed;
  });
  const chooseCustom = () => {
    update(activateCustomAnswer(draft));
    window.setTimeout(() => customInput.current?.focus(), 0);
  };
  const submit = async () => {
    if (pending) return;
    setError(''); setPending(true);
    try {
      await Chat.submitQuestionnaire({
        conversationId,
        requestId,
        questionnaireId: questionnaire.id,
        answers: buildQuestionnaireAnswers(questions, drafts),
      });
    } catch (reason) { setPending(false); setError(errorText(reason)); }
  };
  const last = current === questions.length - 1;
  const multi = question.multiSelect;

  return <section className="questionnaire" aria-labelledby="questionnaire-title">
    <header className="questionnaire-header">
      <div><strong>{question.header}</strong><span>{t(`第 ${current + 1} 题 / 共 ${questions.length} 题`, `Question ${current + 1} of ${questions.length}`)}</span></div>
      <button className="quiet-button" disabled={pending} onClick={() => void cancel()}>{t('取消', 'Cancel')}</button>
    </header>
    <div className="questionnaire-progress" aria-hidden="true">{questions.map((item, index) => <span className={`${index === current ? 'current' : ''}${drafts[item.questionIndex] ? ' answered' : ''}`} key={item.questionIndex}/>)}</div>
    <div className="questionnaire-body">
      <h2 id="questionnaire-title">{question.question}</h2>
      <p className="questionnaire-instruction">{multi ? t('可选择多项，或填写自定义回答', 'Choose one or more, or write a custom answer') : t('选择一项，或填写自定义回答', 'Choose one, or write a custom answer')}</p>
      <div className="question-options" role={multi ? 'group' : 'radiogroup'} aria-label={question.question}>
        {question.options.map(option => {
          const selected = Boolean((draft?.kind === 'option' && draft.answer === option.label) || (draft?.kind === 'multi' && draft.selected.includes(option.label)));
          return <div className={`question-option${selected ? ' selected' : ''}`} key={option.label}>
            <button className="question-option-select" role={multi ? 'checkbox' : 'radio'} aria-checked={selected} disabled={pending} onClick={() => update(selectQuestionOption(question, draft, option.label))}>
              <span className={`question-control ${multi ? 'checkbox' : 'radio'}`} aria-hidden="true">{selected && <Check/>}</span>
              <span><strong>{option.label}</strong><small>{option.description}</small></span>
            </button>
            {!multi && option.preview && <button className="question-preview-button" disabled={pending} aria-label={t(`预览 ${option.label}`, `Preview ${option.label}`)} onClick={() => setPreview({label: option.label, markdown: option.preview!})}><Eye/>{t('预览', 'Preview')}</button>}
          </div>;
        })}
        <div className={`custom-answer${draft?.kind === 'custom' ? ' selected' : ''}`}>
          <button className="custom-answer-toggle" role={multi ? undefined : 'radio'} aria-checked={multi ? undefined : draft?.kind === 'custom'} aria-pressed={multi ? draft?.kind === 'custom' : undefined} disabled={pending} onClick={chooseCustom}><span className="question-control radio" aria-hidden="true">{draft?.kind === 'custom' && <Check/>}</span><Pencil/><strong>{t('自定义回答', 'Custom answer')}</strong></button>
          {draft?.kind === 'custom' && <textarea ref={customInput} rows={3} disabled={pending} aria-label={t('自定义回答', 'Custom answer')} placeholder={t('输入你的回答…', 'Type your answer…')} value={draft.answer} onChange={event => update(setCustomAnswer(event.target.value))}/>}
        </div>
      </div>
    </div>
    <ErrorNotice error={error}/>
    <div className="questionnaire-actions">
      <button className="button secondary-button" disabled={pending || current === 0} onClick={() => setCurrent(index => index - 1)}><ArrowLeft/>{t('上一题', 'Previous')}</button>
      <button className="button" disabled={pending} onClick={() => last ? void submit() : setCurrent(index => index + 1)}>{pending ? t('正在提交…', 'Submitting…') : last ? t('提交回答', 'Submit answers') : t('下一题', 'Next')} {!pending && !last && <ArrowRight/>}</button>
    </div>
    {questions.length > 1 && <small className="questionnaire-hint">{t('切换题目会保留已填答案', 'Your answers are saved as you move between questions')}</small>}
    {preview && <div className="question-preview-layer"><section className="question-preview" role="dialog" aria-modal="true" aria-labelledby="question-preview-title">
      <header><div><small>{t('选项预览', 'Option preview')}</small><h2 id="question-preview-title">{preview.label}</h2></div><button className="icon-button" autoFocus aria-label={t('关闭预览', 'Close preview')} onClick={() => setPreview(undefined)}><X/></button></header>
      <div className="question-preview-content"><Markdown text={preview.markdown}/></div>
      <div className="question-preview-footer"><button className="button secondary-button full" onClick={() => setPreview(undefined)}>{t('返回问题', 'Back to question')}</button></div>
    </section></div>}
  </section>;
}
