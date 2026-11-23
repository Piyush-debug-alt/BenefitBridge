function smtpConfig(smtpUrl, from) {
  const url = new URL(smtpUrl);
  if (!['smtp:', 'smtps:'].includes(url.protocol) || !url.hostname ||
      !['', '/'].includes(url.pathname) || url.search || url.hash || /[\r\n]/.test(from)) {
    throw new Error('SMTP_URL must be an SMTP or SMTPS connection URL. MAIL_FROM must be a single sender.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const secure = url.protocol === 'smtps:';
  const local = ['localhost', '127.0.0.1', '::1'].includes(host);
  return {
    from,
    transport: {
      host,
      port: url.port ? Number(url.port) : secure ? 465 : 587,
      secure,
      requireTLS: !local && !secure,
      ...(url.username && { auth: { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } }),
    },
  };
}

export function readAuthConfig(env = process.env, dataset = 'authorized') {
  const demo = dataset === 'synthetic';
  const get = name => env[(demo ? 'DEMO_' : '') + name]?.trim() || undefined;
  const local = 'http://127.0.0.1:' + (demo ? '5174' : '5173');
  const origin = new URL(get('APP_ORIGIN') ?? local);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
  if (origin.href !== origin.origin + '/' || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback))) {
    throw new Error('APP_ORIGIN must be a single HTTPS origin or a local HTTP origin.');
  }
  if (env.NODE_ENV === 'production' && origin.protocol !== 'https:') {
    throw new Error('APP_ORIGIN must use HTTPS in production.');
  }

  const clientId = get('GOOGLE_CLIENT_ID');
  const clientSecret = get('GOOGLE_CLIENT_SECRET');
  if (Boolean(clientId) !== Boolean(clientSecret)) throw new Error('Set both Google OAuth credentials or leave both blank.');

  const smtpUrl = get('SMTP_URL');
  const from = get('MAIL_FROM');
  if (Boolean(smtpUrl) !== Boolean(from)) throw new Error('Set both SMTP_URL and MAIL_FROM or leave both blank.');

  const prefix = origin.protocol === 'https:' ? '__Host-' : '';
  const suffix = demo ? '_demo' : '';
  return {
    origin: origin.origin,
    secureCookies: origin.protocol === 'https:',
    allowUnverifiedEmail: loopback && env.NODE_ENV !== 'production' && !smtpUrl,
    sessionCookie: prefix + 'bb_session' + suffix,
    googleCookie: prefix + 'bb_google' + suffix,
    google: clientId ? { clientId, clientSecret, redirectUri: origin.origin + '/api/v1/auth/google/callback' } : null,
    smtp: smtpUrl ? smtpConfig(smtpUrl, from) : null,
  };
}
