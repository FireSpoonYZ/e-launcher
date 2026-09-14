import assert from 'node:assert/strict';
import test from 'node:test';
import {activateCustomAnswer, buildQuestionnaireAnswers, selectQuestionOption, setCustomAnswer} from '../src/questionnaireState.ts';

const questions = [{
  questionIndex: 0,
  question: 'Approach?',
  header: 'Approach',
  multiSelect: false,
  options: [
    {label: 'Safe', description: 'Conservative'},
    {label: 'Fast', description: 'Quick'},
  ],
}, {
  questionIndex: 1,
  question: 'Extras?',
  header: 'Extras',
  multiSelect: true,
  options: [
    {label: 'Tests', description: 'Add tests'},
    {label: 'Docs', description: 'Add docs'},
  ],
}, {
  questionIndex: 2,
  question: 'Anything else?',
  header: 'Other',
  multiSelect: false,
  options: [
    {label: 'No', description: 'Nothing else'},
    {label: 'Later', description: 'Decide later'},
  ],
}];

test('keeps answers by question and emits one ordered final submission', () => {
  const drafts = {};
  drafts[1] = selectQuestionOption(questions[1], drafts[1], 'Docs');
  drafts[1] = selectQuestionOption(questions[1], drafts[1], 'Tests');
  drafts[0] = selectQuestionOption(questions[0], drafts[0], 'Safe');
  drafts[2] = setCustomAnswer('Use the existing layout.');

  assert.deepEqual(buildQuestionnaireAnswers(questions, drafts), [
    {questionIndex: 0, kind: 'option', answer: 'Safe'},
    {questionIndex: 1, kind: 'multi', selected: ['Tests', 'Docs']},
    {questionIndex: 2, kind: 'custom', answer: 'Use the existing layout.'},
  ]);
});

test('custom answers are exclusive and empty answers are not submitted', () => {
  let draft = selectQuestionOption(questions[1], undefined, 'Tests');
  draft = activateCustomAnswer(draft);
  draft = setCustomAnswer('Write my own');
  assert.deepEqual(draft, {kind: 'custom', answer: 'Write my own'});

  assert.deepEqual(buildQuestionnaireAnswers(questions, {
    0: {kind: 'custom', answer: '   '},
    1: selectQuestionOption(questions[1], {kind: 'multi', selected: ['Tests']}, 'Tests'),
  }), []);
});
