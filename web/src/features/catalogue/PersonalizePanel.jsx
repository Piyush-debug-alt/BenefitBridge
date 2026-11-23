import { useEffect, useId, useRef, useState } from 'react';
import { stateNames } from './regions.js';

const regions = Object.entries(stateNames).sort(([, left], [, right]) => left.localeCompare(right));
const rupeeDigits = new Intl.NumberFormat('en-IN');
const wholeRupees = /^\d+(?:,\d+)*$/;

function StateInput({ id, name, answer }) {
  const [selected, setSelected] = useState(() => answer && !Object.hasOwn(stateNames, answer) ? 'other' : answer ?? '');
  return <>
    <div className="select-wrap">
      <select id={id} name={name} value={selected} onChange={event => setSelected(event.target.value)}>
        <option value="">Skip</option>
        {regions.map(([code, label]) => <option value={code} key={code}>{label} ({code})</option>)}
        <option value="other">Enter a different two-letter code</option>
      </select>
    </div>
    {selected === 'other' && <label className="custom-region">Two-letter code
      <input className="question-input" name={name + '-custom'} type="text" maxLength={2} pattern="[A-Za-z]{2}"
        autoCapitalize="characters" spellCheck={false} defaultValue={answer && !Object.hasOwn(stateNames, answer) ? answer : ''} />
    </label>}
  </>;
}

function IncomeInput({ id, question, answer }) {
  const hintId = useId();

  function validate(event) {
    const input = event.currentTarget;
    const value = input.value;
    const number = Number(value.replaceAll(',', ''));
    const valid = !value || (wholeRupees.test(value) && Number.isSafeInteger(number) && number >= question.min && number <= question.max);
    input.setCustomValidity(valid ? '' : `Enter a whole amount between ₹${rupeeDigits.format(question.min)} and ₹${rupeeDigits.format(question.max)}.`);
    if (event.type === 'blur' && value && valid) input.value = rupeeDigits.format(number);
  }

  return <>
    <div className="currency-input"><span aria-hidden="true">₹</span>
      <input className="question-input" id={id} name={question.id} type="text" inputMode="numeric"
        aria-describedby={hintId} defaultValue={answer === undefined ? '' : rupeeDigits.format(answer)} onChange={validate} onBlur={validate} />
    </div>
    <p className="field-hint" id={hintId}>Use whole rupees, for example 2,50,000.</p>
  </>;
}

export function Question({ question, answer }) {
  const id = useId();
  return (
    <div className="filter-field">
      <label htmlFor={id}>{question.label}</label>
      {question.type === 'boolean' ? (
        <div className="select-wrap">
          <select id={id} name={question.id} defaultValue={answer === undefined ? '' : String(answer)}>
            <option value="">Skip</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </div>
      ) : question.type === 'state' ? (
        <StateInput id={id} name={question.id} answer={answer} />
      ) : question.id === 'annualIncome' ? (
        <IncomeInput id={id} question={question} answer={answer} />
      ) : (
        <input className="question-input" id={id} name={question.id} type="number" step={1}
          min={question.min} max={question.max} defaultValue={answer ?? ''} />
      )}
    </div>
  );
}

export function readAnswers(form, questions) {
  const values = new FormData(form);
  const answers = {};
  for (const question of questions) {
    let value = values.get(question.id);
    if (question.type === 'state' && value === 'other') value = values.get(question.id + '-custom');
    if (value !== '' && value !== null) {
      answers[question.id] = question.type === 'boolean' ? value === 'true'
        : question.type === 'state' ? value.toUpperCase() : Number(value.replaceAll(',', ''));
    }
  }
  return answers;
}

function Questionnaire({ questions, answers, onSubmit }) {
  const [answered, setAnswered] = useState(() => questions.filter(({ id }) => answers?.[id] !== undefined).length);
  return (
    <form className="question-form" onSubmit={onSubmit} onChange={event => {
      const form = event.currentTarget;
      const entered = readAnswers(form, questions);
      setAnswered(questions.filter(({ id }) => {
        const control = form.elements.namedItem(id);
        const field = control?.value === 'other' ? form.elements.namedItem(id + '-custom') : control;
        return Object.hasOwn(entered, id) && field?.validity.valid;
      }).length);
    }}>
      {questions.length === 0 && <p className="notice">No questionnaire is available for these results. The eligibility information still needs verification.</p>}
      {questions.length > 0 && <div className="question-progress">
        <p role="status">{answered} of {questions.length} answered</p>
        <progress value={answered} max={questions.length} aria-label="Questions answered" />
      </div>}
      {questions.map(question => <Question key={question.id} question={question} answer={answers?.[question.id]} />)}
      <div className="question-submit"><button className="primary-button" type="submit">Apply personalization</button></div>
    </form>
  );
}

export function PersonalizePanel({ questions, answers, onApply, onClose }) {
  const dialog = useRef(null);
  const closeButton = useRef(null);
  const titleId = useId();
  const explanationId = useId();

  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    closeButton.current.focus();
    return () => {
      if (element.open) element.close();
    };
  }, []);

  function close() {
    dialog.current.close();
    onClose();
  }

  function submit(event) {
    event.preventDefault();
    const next = { ...answers };
    for (const { id } of questions.data.questions) delete next[id];
    onApply({ ...next, ...readAnswers(event.currentTarget, questions.data.questions) });
    close();
  }

  return (
    <dialog className="personalize-panel" ref={dialog} aria-labelledby={titleId} aria-describedby={explanationId}
      onCancel={event => { event.preventDefault(); close(); }}>
      <div className="personalize-panel-content">
        <header className="panel-heading">
          <h2 id={titleId}>Personalize Results</h2>
          <button className="secondary-button" type="button" ref={closeButton} onClick={close}>Close</button>
        </header>
        <p id={explanationId}>Every question is optional. Your answers stay available in this tab until you reset or reload it.</p>
        <p className="personalization-note">An estimate can help you decide what to read next. The scheme issuer confirms eligibility.</p>
        {questions.isPending && <p role="status">Loading questions…</p>}
        {questions.isError && (
          <div role="alert">
            <p>Questions are currently unavailable.</p>
            <button className="secondary-button" type="button" onClick={() => questions.refetch()}>Retry</button>
          </div>
        )}
        {questions.isSuccess && (
          <Questionnaire questions={questions.data.questions} answers={answers} onSubmit={submit} />
        )}
      </div>
    </dialog>
  );
}
