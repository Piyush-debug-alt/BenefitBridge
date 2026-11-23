import { useState } from 'react';
import { Link, Route, Routes } from 'react-router';
import { CataloguePage } from '../features/catalogue/CataloguePage.jsx';
import { SchemePage } from '../features/catalogue/SchemePage.jsx';
import { dataset } from '../features/catalogue/client.js';

export function App() {
  const [answers, setAnswers] = useState(null);

  return (
    <>
      <a href="#main" className="skip-link">Skip to content</a>
      <header className="site-header">
        <div className="shell header-inner">
          <Link className="wordmark" to="/">
            <span className="brand-mark" aria-hidden="true"><span /><span /></span>
            BenefitBridge
          </Link>
          <nav aria-label="Main navigation"><Link to="/">Explore schemes</Link></nav>
        </div>
      </header>
      {dataset === 'synthetic' && (
        <div className="demo-banner">
          <div className="shell"><strong>Synthetic demo.</strong> All listings are fictional and cannot be applied for.</div>
        </div>
      )}
      <main id="main" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<CataloguePage answers={answers} setAnswers={setAnswers} />} />
          <Route path="/schemes/:schemeId" element={<SchemePage />} />
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
    </>
  );
}
