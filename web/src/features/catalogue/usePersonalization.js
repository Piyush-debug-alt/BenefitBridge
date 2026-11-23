import { useEffect, useMemo, useState } from 'react';
import { readCatalogue } from './client.js';

export function usePersonalization(ids, questions, answers) {
  const [evaluation, setEvaluation] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const input = useMemo(() => {
    if (!ids || !questions || answers === null) return null;
    const relevant = questions.filter(({ id }) => Object.hasOwn(answers, id));
    return {
      schemeIds: ids.split(','),
      answers: Object.fromEntries(relevant.map(({ id }) => [id, answers[id]])),
    };
  }, [ids, questions, answers]);

  useEffect(() => {
    if (!input) {
      setEvaluation(null);
      return;
    }

    const controller = new AbortController();
    readCatalogue('/matches/evaluate', controller.signal, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      cache: 'no-store',
    }).then(data => {
      if (!controller.signal.aborted) setEvaluation({ input, attempt, results: data.results });
    }).catch(error => {
      if (!controller.signal.aborted) setEvaluation({ input, attempt, error });
    });

    return () => controller.abort();
  }, [input, attempt]);

  const current = evaluation?.input === input && evaluation.attempt === attempt ? evaluation : null;
  return {
    matches: current?.results,
    error: current?.error,
    pending: Boolean(input && !current),
    retry: () => setAttempt(count => count + 1),
  };
}
