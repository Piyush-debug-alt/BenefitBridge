import { useEffect, useId, useRef } from 'react';

function Question({ question, answer }) {
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
      ) : (
        <input className="question-input" id={id} name={question.id} type="number" step={1}
          min={question.min} max={question.max} defaultValue={answer ?? ''} />
      )}
    </div>
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
    const form = new FormData(event.currentTarget);
    const next = { ...answers };
    for (const question of questions.data.questions) {
      const value = form.get(question.id);
      delete next[question.id];
      if (value !== '' && value !== null) {
        next[question.id] = question.type === 'boolean' ? value === 'true' : Number(value);
      }
    }
    onApply(next);
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
        <p id={explanationId}>Skip any question. Answers are sent for matching and stay available in this tab until you reset or reload it.</p>
        {questions.isPending && <p role="status">Loading questions…</p>}
        {questions.isError && (
          <div role="alert">
            <p>Questions are currently unavailable.</p>
            <button className="secondary-button" type="button" onClick={() => questions.refetch()}>Retry</button>
          </div>
        )}
        {questions.isSuccess && (
          <form className="question-form" onSubmit={submit}>
            {questions.data.questions.length === 0 && (
              <p>Eligibility information for these results requires verification. There are no supported questions on this page.</p>
            )}
            {questions.data.questions.map(question => (
              <Question key={question.id} question={question} answer={answers?.[question.id]} />
            ))}
            <div><button className="primary-button" type="submit">Apply personalization</button></div>
          </form>
        )}
      </div>
    </dialog>
  );
}
