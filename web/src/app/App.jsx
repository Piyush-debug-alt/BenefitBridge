import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router';
import { CataloguePage } from '../features/catalogue/CataloguePage.jsx';
import { SchemePage } from '../features/catalogue/SchemePage.jsx';
import { dataset } from '../features/catalogue/client.js';
import { AccountPage } from '../features/account/AccountPage.jsx';
import { AuthProvider, useAuth } from '../features/account/AuthProvider.jsx';
import { NotificationsPage } from '../features/account/NotificationsPage.jsx';
import { AdminPage } from '../features/account/AdminPage.jsx';

function Wordmark() {
  return <Link className="wordmark" to="/">
    <span className="brand-mark" aria-hidden="true"><span /><span /></span>
    BenefitBridge
  </Link>;
}

function Header() {
  const { user } = useAuth();
  return (
    <header className="site-header">
      <div className="shell header-inner">
        <Wordmark />
        <nav aria-label="Main navigation">
          <NavLink className="nav-explore" to="/" end>Explore schemes</NavLink>
          {user?.isAdministrator && <NavLink to="/admin">Administration</NavLink>}
          {user && <NavLink to="/account/notifications">Notifications</NavLink>}
          <NavLink className="nav-account" to="/account" end>{user ? 'Account' : 'Sign in'}</NavLink>
        </nav>
      </div>
    </header>
  );
}

export function App() {
  const [answers, setAnswers] = useState(null);
  const { pathname } = useLocation();
  const previousPath = useRef(pathname);
  const main = useRef(null);

  useEffect(() => {
    if (previousPath.current === pathname) return;
    previousPath.current = pathname;
    main.current?.focus();
  }, [pathname]);

  return (
    <AuthProvider clearAnswers={setAnswers}>
      <a href="#main" className="skip-link">Skip to content</a>
      <Header />
      {dataset === 'synthetic' && (
        <div className="demo-banner">
          <div className="shell"><span className="demo-indicator" aria-hidden="true" /><strong>Synthetic demo</strong><span>All listings are fictional and cannot be applied for.</span></div>
        </div>
      )}
      <main id="main" tabIndex={-1} ref={main}>
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
        <div className="shell footer-inner">
          <div><Wordmark /><p>An independent guide to Indian government schemes. No government affiliation.</p></div>
          <p>Confirm requirements and application instructions with the official issuer.</p>
        </div>
      </footer>
    </AuthProvider>
  );
}
