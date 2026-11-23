import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app/App.jsx';

const signedInUser = { id: 'test-user', email: 'user@example.test', emailVerified: false };
const scheme = {
  _id: '000000000000000000000001',
  canonicalName: 'Test scheme', description: 'Test description',
  categoryIds: ['Energy'], benefitTypes: ['Rebate'], governmentLevel: 'central',
  issuer: 'Test issuer', nationwide: true, stateCodes: [], lifecycleStatus: 'active',
  verificationStatus: 'verified', benefits: [], requiredDocuments: [], sourceRefs: [],
};
const questions = [{ id: 'age', label: 'What is your age in years?', type: 'integer', min: 0, max: 120 }];
const fixedDate = '2026-11-23T00:00:00.000Z';

function response(data, status = 200) {
  const headers = { 'X-BenefitBridge-Dataset': 'authorized' };
  return status === 204 ? new Response(null, { status, headers }) : Response.json(data, { status, headers });
}

function renderApp(entry) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}><App /></MemoryRouter>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('supports registration, sign-in, profile consent and deletion, bookmarks, and logout through the UI', async () => {
  let registered = false;
  let signedIn = false;
  let profile = null;
  let bookmarked = false;
  const api = vi.fn(async (url, { method = 'GET', body } = {}) => {
    const path = url.slice('/api/v1'.length).split('?')[0];
    if (path === '/me') return signedIn ? response({ user: signedInUser }) : response({}, 401);
    if (path === '/auth/options') return response({ googleEnabled: true, emailEnabled: false });
    if (path === '/auth/register') {
      registered = true;
      return response({ message: 'Registration submitted.' }, 202);
    }
    if (path === '/auth/login') {
      if (!registered || JSON.parse(body).password !== 'test-passphrase-long') {
        return response({ message: 'Email or password is incorrect.' }, 401);
      }
      signedIn = true;
      return response({ user: signedInUser });
    }
    if (path === '/auth/logout') {
      signedIn = false;
      return response(null, 204);
    }
    if (path === '/me/profile') {
      if (method === 'PUT') {
        const { consent, attributes } = JSON.parse(body);
        expect(consent).toBe(true);
        profile = { attributes, consentAt: fixedDate, updatedAt: fixedDate };
      }
      if (method === 'DELETE') {
        profile = null;
        return response(null, 204);
      }
      return response({ profile, questions });
    }
    if (path === '/me/bookmarks') {
      if (method === 'POST') {
        expect(JSON.parse(body)).toEqual({ schemeId: scheme._id });
        bookmarked = true;
        return response({ bookmarked });
      }
      return response({ items: bookmarked ? [{ schemeId: scheme._id, name: scheme.canonicalName }] : [], totalPages: 1 });
    }
    if (path === '/me/bookmarks/' + scheme._id) {
      if (method === 'DELETE') {
        bookmarked = false;
        return response(null, 204);
      }
      return response({ bookmarked });
    }
    if (path === '/schemes/' + scheme._id) return response({ dataset: 'authorized', item: scheme });
    if (path === '/facets') return response({ dataset: 'authorized' });
    return response({ dataset: 'authorized', items: [scheme], pagination: { page: 1, total: 1, totalPages: 1 } });
  });
  vi.stubGlobal('fetch', api);

  const user = renderApp('/account');
  expect((await screen.findByRole('link', { name: 'Continue with Google' })).getAttribute('href')).toBe('/api/v1/auth/google/start');
  await user.click(screen.getByRole('link', { name: 'Create an account' }));
  await user.type(screen.getByLabelText('Email'), signedInUser.email);
  await user.type(screen.getByLabelText('Password'), 'test-passphrase-long');
  await user.click(screen.getByRole('button', { name: 'Create account' }));
  await screen.findByText('Registration submitted.');
  await user.click(screen.getByRole('link', { name: 'Back to sign in' }));
  await user.type(screen.getByLabelText('Email'), signedInUser.email);
  const password = screen.getByLabelText('Password');
  await user.type(password, 'wrong-password');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByText('Email or password is incorrect.');
  await user.clear(password);
  await user.type(password, 'test-passphrase-long');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('heading', { name: 'Your account' });

  await user.type(await screen.findByLabelText(questions[0].label), '27');
  await user.click(screen.getByRole('button', { name: 'Save profile' }));
  expect(api.mock.calls.some(([path, options]) => path.endsWith('/profile') && options.method === 'PUT')).toBe(false);
  await user.click(screen.getByRole('checkbox', { name: /agree to save these answers/ }));
  await user.click(screen.getByRole('button', { name: 'Save profile' }));
  await screen.findByText('Profile saved.');
  expect(screen.getByLabelText(questions[0].label).value).toBe('27');
  expect(screen.getByRole('checkbox', { name: /agree to save these answers/ }).checked).toBe(false);

  await user.click(screen.getByRole('link', { name: 'Explore schemes' }));
  await user.click(await screen.findByRole('link', { name: scheme.canonicalName }));
  await user.click(await screen.findByRole('button', { name: 'Bookmark scheme' }));
  await screen.findByRole('button', { name: 'Remove bookmark' });
  await user.click(screen.getByRole('link', { name: 'Account' }));
  const bookmarks = await screen.findByRole('region', { name: 'Bookmarks' });
  await within(bookmarks).findByRole('link', { name: scheme.canonicalName });
  await user.click(within(bookmarks).getByRole('button', { name: 'Remove bookmark: ' + scheme.canonicalName }));
  await within(bookmarks).findByText('No bookmarks on this page.');

  await user.click(await screen.findByRole('button', { name: 'Delete saved profile' }));
  await user.click(screen.getByRole('button', { name: 'Confirm profile deletion' }));
  await screen.findByText('Saved profile deleted.');
  expect(screen.getByLabelText(questions[0].label).value).toBe('');
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  await screen.findByRole('heading', { name: 'Sign in' });
  expect(screen.queryByRole('heading', { name: 'Questionnaire profile' })).toBeNull();
});

it('consumes an email verification link with a POST body', async () => {
  const token = 'a'.repeat(43);
  const api = vi.fn(async (url, options) => {
    if (url.endsWith('/me')) return response({}, 401);
    if (url.endsWith('/auth/options')) return response({ emailEnabled: true });
    expect(url).toBe('/api/v1/auth/email/verify');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ token });
    return response({ message: 'Email verified.' });
  });
  vi.stubGlobal('fetch', api);

  const user = renderApp('/account?mode=verify#' + token);
  await user.click(await screen.findByRole('button', { name: 'Verify email' }));
  await screen.findByText('Email verified.');
  expect(api.mock.calls.every(([url]) => !url.includes(token))).toBe(true);
});

it('shows the in-app inbox, saves preferences, and toggles read status', async () => {
  let settings = { bookmarkUpdates: false, profileMatches: false };
  let readAt = null;
  const api = vi.fn(async (url, { method, body }) => {
    if (url.endsWith('/me')) return response({ user: signedInUser });
    if (url.endsWith('/notification-preferences')) {
      if (method === 'PUT') settings = JSON.parse(body);
      return response({ preferences: settings });
    }
    if (method === 'PATCH') {
      readAt = JSON.parse(body).read ? fixedDate : null;
      return response({ readAt });
    }
    return response({
      items: [{ _id: 'notification-id', schemeId: scheme._id, schemeName: scheme.canonicalName,
        type: 'bookmark_update', createdAt: fixedDate, readAt }],
      unread: readAt ? 0 : 1,
      totalPages: 1,
    });
  });
  vi.stubGlobal('fetch', api);
  const user = renderApp('/account/notifications');
  await screen.findByText('1 unread');
  expect(screen.getByRole('link', { name: scheme.canonicalName }).getAttribute('href')).toBe('/schemes/' + scheme._id);
  await user.click(await screen.findByRole('checkbox', { name: /verified updates/i }));
  await user.click(screen.getByRole('button', { name: 'Save preferences' }));
  await screen.findByText('Notification preferences saved.');
  expect(settings).toEqual({ bookmarkUpdates: true, profileMatches: false });
  await user.click(screen.getByRole('button', { name: 'Mark read' }));
  await screen.findByText('0 unread');
  await user.click(screen.getByRole('button', { name: 'Mark unread' }));
  await screen.findByText('1 unread');
});

it('lets an administrator inspect the source and queue a review decision', async () => {
  const review = { _id: 'record-id', externalRecordId: 'source-record', kind: 'candidate',
    status: 'pending', changedFields: ['benefits'], normalization: { record: {} } };
  const api = vi.fn(async (url, options) => {
    if (url.endsWith('/me')) return response({ user: { ...signedInUser, isAdministrator: true } });
    if (url.endsWith('/admin/sources')) return response({ sources: [] });
    if (url.endsWith('/admin/sync-jobs')) return response({ items: [] });
    if (url.includes('/admin/reviews?')) return response({ items: [review] });
    if (url.endsWith('/record-id/decision')) {
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body)).toEqual({ action: 'approve', reason: 'Checked permitted source' });
      return response({ status: 'approved' });
    }
    return response({ review, provenance: { permittedReference: 'https://source.example.invalid/record' } });
  });
  vi.stubGlobal('fetch', api);
  const user = renderApp('/admin');
  await user.click(await screen.findByRole('button', { name: /source-record/ }));
  await user.click(await screen.findByText('Evidence and previous version'));
  expect(screen.getByText(/source.example.invalid/)).toBeTruthy();
  await user.type(screen.getByLabelText('Evidence or reason'), 'Checked permitted source');
  await user.click(screen.getByRole('button', { name: 'Save decision' }));
  await screen.findByText(/Decision saved/);
});
