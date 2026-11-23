import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app/App.jsx';

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
