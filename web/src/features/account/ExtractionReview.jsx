import { useState } from 'react';
import { useAuth } from './AuthProvider.jsx';
import { useAccountResource } from './useAccountResource.js';

const conditionText = {
  atLeast: 'at least',
  atMost: 'at most',
  eq: 'equals',
};

const warningText = {
  INSTRUCTION_LIKE_TEXT: 'Instruction-like text was found in the source.',
  UNCLASSIFIED_SOURCE_TEXT: 'The source may contain eligibility details the extractor could not classify.',
  NO_EXPLICIT_ELIGIBILITY: 'The source contains no explicit eligibility statement in the supported format.',
  AMBIGUOUS_LOGIC_OR_CONDITION: 'The condition or relationship between conditions is ambiguous.',
  UNSUPPORTED_CONDITION: 'This source condition needs manual interpretation.',
  INVALID_PROPOSAL_SCHEMA: 'The draft contains invalid or unsupported fields.',
  UNSUPPORTED_OR_INVENTED_PROPOSAL: 'This proposed condition is not supported by its source quote.',
  MISSING_SUPPORTED_CONDITIONS: 'The draft omits one or more source conditions.',
  PATHWAYS_DO_NOT_MATCH_EVIDENCE: 'The proposed pathways do not preserve the source logic.',
  CONTRADICTORY_OR_INVALID_RULE: 'The conditions contradict each other or the rule is invalid.',
  COMPLEX_ALTERNATIVES: 'The source has more alternatives than this rule format supports.',
  TOO_MANY_CONDITIONS: 'The source exceeds the number of conditions supported in a pathway.',
};

function Preview({ value }) {
  if (!value) return null;
  return (
    <>
      <p role="status">{value.valid ? 'Evidence checks passed. Reviewer approval is still required.' : 'This draft needs review before approval.'}</p>
      {value.warnings?.length > 0 && <ul className="detail-list">
        {value.warnings.map(({ code, quote }, i) => (
          <li key={code + i}>{warningText[code] ?? code}{quote && <> <q>{quote}</q></>}</li>
        ))}
      </ul>}
      {value.replacesExisting && <p>Approval changes existing verified or source-supplied criteria.</p>}
      {value.evidence?.map((path, index) => (
        <div key={index}>
          <p><strong>Pathway {index + 1}</strong> · All listed conditions</p>
          <ul className="detail-list">{path.map((item, i) => (
            <li key={i}>{item.attribute} {conditionText[item.operator]} {String(item.value)} · <q>{item.quote}</q></li>
          ))}</ul>
        </div>
      ))}
      {value.questions?.length > 0 && <div>
        <strong>Optional questionnaire questions</strong>
        <ul className="detail-list">{value.questions.map(question => <li key={question.id}>{question.label}</li>)}</ul>
      </div>}
    </>
  );
}

function Editor({ data, path, onDecision }) {
  const { request } = useAuth();
  const [text, setText] = useState(JSON.stringify(data.extraction.result.proposal, null, 2));
  const [wording, setWording] = useState({});
  const [preview, setPreview] = useState(data.preview);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  async function send(action, form) {
    setMessage(null);
    setBusy(true);
    try {
      const draft = action === 'reject' ? {} : { proposal: JSON.parse(text), questionWording: wording };
      if (action === 'validate') {
        setPreview(await request(path + '/validate', { method: 'POST', data: draft }));
        return;
      }
      const fields = new FormData(form);
      await request(path + '/decision', { method: 'POST', data: {
        ...draft, action, reason: fields.get('reason'), replaceExistingRule: fields.has('replaceExistingRule'),
      } });
      onDecision();
    } catch (error) {
      setMessage(error instanceof SyntaxError ? 'Enter valid JSON for the proposed conditions.' : error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="account-form" onSubmit={event => {
      event.preventDefault();
      send(event.nativeEvent.submitter?.value ?? 'approve', event.currentTarget);
    }}>
      <label>Edit proposed conditions and quotes
        <textarea className="question-input extraction-draft" value={text} onChange={event => setText(event.target.value)} />
      </label>
      {preview?.questions?.map(question => (
        <label key={question.id}>Wording for {question.id}
          <select className="question-input" value={wording[question.id] ?? 'standard'}
            onChange={event => setWording(value => ({ ...value, [question.id]: event.target.value }))}>
            <option value="standard">{question.wording.standard}</option>
            <option value="alternate">{question.wording.alternate}</option>
          </select>
        </label>
      ))}
      <button className="secondary-button" type="button" disabled={busy} onClick={() => send('validate')}>Validate edited proposal</button>
      <Preview value={preview} />
      <label>Extraction decision reason
        <textarea className="question-input" name="reason" minLength={3} maxLength={500} required />
      </label>
      <label className="consent-check"><input type="checkbox" name="replaceExistingRule" /> Confirm replacement if existing criteria differ</label>
      {message && <p role="alert">{message}</p>}
      <div className="account-actions">
        <button className="primary-button" type="submit" value="approve" disabled={busy}>Approve proposal and queue publication</button>
        <button className="secondary-button" type="submit" value="reject" disabled={busy}>Reject AI proposal</button>
      </div>
    </form>
  );
}

export function ExtractionReview({ reviewId, reviewStatus, onDecision }) {
  const path = '/admin/reviews/' + reviewId + '/extraction';
  const resource = useAccountResource(path);
  const { data } = resource;
  return (
    <section className="extraction-review" aria-label="AI eligibility review">
      <h3>AI eligibility review</h3>
      {resource.pending && <p role="status">Loading extraction…</p>}
      {resource.error && <p role="alert">{resource.error.message}</p>}
      {data && (
        <>
          <p>{data.extraction.provider} · {data.extraction.providerVersion} · {data.extraction.status.replaceAll('_', ' ')}</p>
          {data.extraction.errorCode && <p role="alert">{data.extraction.errorCode}</p>}
          <details><summary>Source text and provenance</summary>
            <p>{data.extraction.input.url} · {data.extraction.input.field}</p>
            <blockquote>{data.extraction.input.text}</blockquote>
          </details>
          {data.decision && <p role="status">AI proposal {data.decision.status} · {data.decision.reason}</p>}
          {data.extraction.result && !data.decision && ['pending', 'deferred'].includes(reviewStatus)
            ? <Editor data={data} path={path} onDecision={onDecision} /> : <Preview value={data.preview} />}
        </>
      )}
      <button className="text-link" type="button" onClick={resource.retry}>Refresh extraction</button>
    </section>
  );
}
