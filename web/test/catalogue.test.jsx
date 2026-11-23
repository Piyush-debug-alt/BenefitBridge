import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app/App.jsx';
import pilot from '../../data/authorized/pib-pilot.json';

const item = {
  _id: '000000000000000000000001', canonicalName: 'Test result', description: 'Test description',
  categoryIds: ['Energy'], benefitTypes: ['Rebate'], governmentLevel: 'central',
  issuer: 'Test issuer', nationwide: true, stateCodes: [], lifecycleStatus: 'active',
  verificationStatus: 'unverified', benefits: [], requiredDocuments: [], sourceRefs: [],
};

function renderApp(entry = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}><App /></MemoryRouter>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

function json(data, status = 200) {
  return Response.json(data, { status });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('submits a goal search, opens the detail page, and returns to the search', async () => {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async url => {
    calls.push(url);
    if (url.endsWith('/facets')) return json({ dataset: 'authorized', states: ['MH'] });
    if (url.endsWith(item._id)) return json({ dataset: 'authorized', item });
    return json({
      dataset: 'authorized',
      items: url.includes('q=solar') ? [item] : [],
      pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
    });
  }));

  const user = renderApp();
  await user.type(screen.getByRole('searchbox', { name: 'Search schemes' }), 'solar');
  await user.click(screen.getByRole('button', { name: 'Search' }));
  const state = await screen.findByRole('combobox', { name: 'State or territory' });
  await user.selectOptions(state, 'MH');
  await user.click(await screen.findByRole('link', { name: 'Test result' }));
  expect(await screen.findByRole('heading', { name: 'Test result', level: 1 })).toBeTruthy();
  await user.click(screen.getByRole('link', { name: 'Back to schemes' }));
  expect(await screen.findByRole('link', { name: 'Test result' })).toBeTruthy();
  expect(screen.getByRole('searchbox').value).toBe('solar');
  expect(screen.getByRole('combobox', { name: 'State or territory' }).value).toBe('MH');
  expect(calls).toContain('/api/v1/schemes?q=solar&state=MH');
});

it('rejects a synthetic API response in regular mode', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ dataset: 'synthetic', items: [item] })));
  renderApp();
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('different data environment');
  expect(screen.queryByText('Test result')).toBeNull();
});

it('shows an accessible not-found state for an unavailable scheme', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ message: 'This scheme could not be found.' }, 404)));
  renderApp('/schemes/' + item._id);
  expect(await screen.findByRole('heading', { name: 'Scheme unavailable' })).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('could not be found');
});

it.each([
  ['pm-surya-ghar', 'https://www.pmsuryaghar.gov.in/'],
  ['pm-vishwakarma', null],
])('renders attributed details and the verified application route for %s', async (id, applicationUrl) => {
  const { record } = pilot.records.find(entry => entry.record.externalRecordId === id);
  vi.stubGlobal('fetch', vi.fn(async url => url.endsWith(item._id)
    ? json({ dataset: 'authorized', item: { ...item, ...record } }) : json({}, 401)));
  renderApp('/schemes/' + item._id);

  await screen.findByRole('heading', { name: record.canonicalName, level: 1 });
  const sources = within(screen.getByRole('complementary', { name: 'Scheme and sources' }));
  for (const { label, url } of record.sourceRefs) expect(sources.getByRole('link', { name: label }).href).toBe(url);
  const application = sources.queryByRole('link', { name: 'Official application portal' });
  expect(application?.href ?? null).toBe(applicationUrl);
  expect(sources.queryByText('Application deadline')).toBeNull();
  if (!applicationUrl) {
    expect(screen.getByText('Availability unknown')).toBeTruthy();
    expect(screen.getByText(/Check with a CSC for current intake/)).toBeTruthy();
  }
});

function enableDialogInDom() {
  const prototype = HTMLDialogElement.prototype;
  if (!prototype.showModal) {
    Object.defineProperties(prototype, {
      showModal: { value() { this.setAttribute('open', ''); } },
      close: { value() { this.removeAttribute('open'); } },
    });
  }
}

const question = { id: 'currentlyStudying', label: 'Are you currently studying?', type: 'boolean' };
const second = { ...item, _id: '000000000000000000000002', canonicalName: 'Second result' };
const third = { ...item, _id: '000000000000000000000003', canonicalName: 'Third result' };
const criteria = [{ status: 'PASS', conditions: [{ label: 'Currently studying: yes', status: 'PASS' }] }];
const cardHeadings = () => screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent);

it('asks only relevant questions, preserves all outcomes, and resets ranking and answers', async () => {
  enableDialogInDom();
  const api = vi.fn(async url => {
    if (url.includes('/questions?')) return json({ dataset: 'authorized', questions: [question] });
    if (url.endsWith('/matches/evaluate')) return json({
      dataset: 'authorized',
      results: [
        { schemeId: third._id, outcome: 'POTENTIAL_MATCH', paths: criteria },
        { schemeId: second._id, outcome: 'NEEDS_INFO', reason: 'Eligibility information requires verification.', paths: [] },
        { schemeId: item._id, outcome: 'KNOWN_UNMET', paths: [] },
      ],
    });
    if (url.endsWith('/facets')) return json({ dataset: 'authorized' });
    return json({
      dataset: 'authorized', items: [item, second, third],
      pagination: { page: 1, total: 3, totalPages: 1 },
    });
  });
  vi.stubGlobal('fetch', api);

  try {
    const user = renderApp();
    await screen.findByRole('link', { name: item.canonicalName });
    expect(api.mock.calls.some(([url]) => url.includes('/questions?'))).toBe(false);

    const trigger = screen.getByRole('button', { name: 'Personalize Results' });
    await user.click(trigger);
    let dialog = await screen.findByRole('dialog', { name: 'Personalize Results' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close' }));
    const input = await within(dialog).findByRole('combobox', { name: question.label });
    await user.selectOptions(input, 'true');
    await user.click(within(dialog).getByRole('button', { name: 'Apply personalization' }));
    expect(document.activeElement).toBe(trigger);
    await screen.findByText('Potential match');
    expect(cardHeadings()).toEqual(['Third result', 'Second result', 'Test result']);
    expect(screen.getByText('More information needed')).toBeTruthy();
    expect(screen.getByText('Known conditions not met')).toBeTruthy();
    const thirdCard = screen.getByRole('heading', { name: third.canonicalName }).closest('article');
    await user.click(within(thirdCard).getByText('Why this result?'));
    expect(within(thirdCard).getByText(/Currently studying: yes/)).toBeTruthy();
    const post = api.mock.calls.find(([url]) => url.endsWith('/matches/evaluate'));
    expect(post[1]).toMatchObject({ method: 'POST', cache: 'no-store' });
    expect(JSON.parse(post[1].body)).toEqual({
      schemeIds: [item._id, second._id, third._id],
      answers: { currentlyStudying: true },
    });

    await user.click(trigger);
    dialog = await screen.findByRole('dialog');
    expect((await within(dialog).findByRole('combobox', { name: question.label })).value).toBe('true');
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await user.click(screen.getByRole('button', { name: 'Reset personalization' }));
    expect(cardHeadings()).toEqual(['Test result', 'Second result', 'Third result']);
    expect(screen.queryByText('Known conditions not met')).toBeNull();
    await user.click(trigger);
    dialog = await screen.findByRole('dialog');
    expect((await within(dialog).findByRole('combobox', { name: question.label })).value).toBe('');
  } finally {
    cleanup();
  }
});

it('reuses applicable answers across pages and ignores responses that arrive after reset', async () => {
  enableDialogInDom();
  let finishSecondPage;
  const api = vi.fn(async (url, options) => {
    if (url.includes('/questions?')) {
      const questions = url.includes(second._id) ? [{ id: 'age', label: 'What is your age in years?', type: 'integer' }] : [question];
      return json({ dataset: 'authorized', questions });
    }
    if (url.endsWith('/matches/evaluate')) {
      const { schemeIds } = JSON.parse(options.body);
      if (schemeIds.includes(second._id)) return new Promise(resolve => { finishSecondPage = resolve; });
      return json({ dataset: 'authorized', results: [{ schemeId: item._id, outcome: 'POTENTIAL_MATCH', paths: criteria }] });
    }
    if (url.endsWith('/facets')) return json({ dataset: 'authorized' });
    const next = url.includes('page=2');
    return json({
      dataset: 'authorized', items: [next ? second : item],
      pagination: { page: next ? 2 : 1, total: 2, totalPages: 2 },
    });
  });
  vi.stubGlobal('fetch', api);

  try {
    const user = renderApp();
    await screen.findByRole('link', { name: item.canonicalName });
    await user.click(screen.getByRole('button', { name: 'Personalize Results' }));
    await user.selectOptions(await screen.findByRole('combobox', { name: question.label }), 'true');
    await user.click(screen.getByRole('button', { name: 'Apply personalization' }));
    await screen.findByText('Potential match');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('link', { name: second.canonicalName });
    await waitFor(() => expect(finishSecondPage).toBeTypeOf('function'));
    const post = api.mock.calls.filter(([url]) => url.endsWith('/matches/evaluate')).at(-1);
    expect(JSON.parse(post[1].body)).toEqual({ schemeIds: [second._id], answers: {} });
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    await screen.findByText('Potential match');
    const previous = api.mock.calls.filter(([url]) => url.endsWith('/matches/evaluate')).at(-1);
    expect(JSON.parse(previous[1].body).answers).toEqual({ currentlyStudying: true });

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(api.mock.calls.filter(([url]) => url.endsWith('/matches/evaluate'))).toHaveLength(4));
    const latest = api.mock.calls.filter(([url]) => url.endsWith('/matches/evaluate')).at(-1);
    await user.click(screen.getByRole('button', { name: 'Reset personalization' }));
    expect(latest[1].signal.aborted).toBe(true);
    await act(async () => finishSecondPage(json({
      dataset: 'authorized', results: [{ schemeId: second._id, outcome: 'NEEDS_INFO', paths: [] }],
    })));
    expect(screen.queryByText('More information needed')).toBeNull();
  } finally {
    cleanup();
  }
});
