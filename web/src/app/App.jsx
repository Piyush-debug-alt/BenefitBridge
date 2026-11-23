import { useState } from 'react';
import { Link, Route, Routes } from 'react-router';
import { CataloguePage } from '../features/catalogue/CataloguePage.jsx';
import { SchemePage } from '../features/catalogue/SchemePage.jsx';
import { dataset } from '../features/catalogue/client.js';
import { AccountPage } from '../features/account/AccountPage.jsx';
import { AuthProvider, useAuth } from '../features/account/AuthProvider.jsx';
import { NotificationsPage } from '../features/account/NotificationsPage.jsx';
import { AdminPage } from '../features/account/AdminPage.jsx';

function Header() {
  const { user } = useAuth();
  return (
    <header className="site-header">
      <div className="shell header-inner">
        <Link className="wordmark" to="/">
          <span className="brand-mark" aria-hidden="true"><span /><span /></span>
          BenefitBridge
        </Link>
        <nav aria-label="Main navigation">
          <Link to="/">Explore schemes</Link>
          <Link to="/account">{user ? 'Account' : 'Sign in'}</Link>
          {user && <Link to="/account/notifications">Notifications</Link>}
          {user?.isAdministrator && <Link to="/admin">Administration</Link>}
        </nav>
      </div>
    </header>
  );
}

export function App() {
  const [answers, setAnswers] = useState(null);

  return (
    <AuthProvider clearAnswers={setAnswers}>
      <a href="#main" className="skip-link">Skip to content</a>
      <Header />
      {dataset === 'synthetic' && (
        <div className="demo-banner">
          <div className="shell"><strong>Synthetic demo.</strong> All listings are fictional and cannot be applied for.</div>
        </div>
      )}
      <main id="main" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<CataloguePage answers={answers} setAnswers={setAnswers} />} />
          <Route path="/schemes/:schemeId" element={<SchemePage />} />
          <Route path="/account" element={<AccountPage answers={answers} setAnswers={setAnswers} />} />
          <Route path="/account/notifications" element={<NotificationsPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="*" element={
            <section className="shell detail-shell">
              <h1>Page unavailable</h1>
              <Link className="text-link" to="/">Explore schemes</Link>
            </section>
          } />
        </Routes>
      </main>
      <footer className="site-footer">
        <div className="shell"><strong>BenefitBridge</strong><span>Independent informational project. No government affiliation.</span></div>
      </footer>
    </AuthProvider>
  );
}
