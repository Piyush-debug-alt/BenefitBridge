import { useId, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { dataset, readCatalogue } from './client.js';
import { displayLabel, SchemeCard } from './presentation.jsx';
import { stateNames } from './regions.js';
import { PersonalizePanel } from './PersonalizePanel.jsx';
import { usePersonalization } from './usePersonalization.js';

const filterFields = [
  ['state', 'State or territory', 'states'],
  ['category', 'Category', 'categories'],
  ['benefitType', 'Benefit type', 'benefitTypes'],
  ['issuer', 'Issuer', 'issuers'],
  ['governmentLevel', 'Government level', 'governmentLevels'],
  ['lifecycleStatus', 'Availability', null],
];
const permittedKeys = new Set(['q', 'goal', 'page', 'limit', ...filterFields.map(([key]) => key)]);
const availability = [['active', 'Active'], ['unknown', 'Unknown'], ['closed', 'Closed']];
const levelNames = { central: 'Central', state: 'State' };

function FilterSelect({ name, label, options, value, update }) {
  const id = useId();
  return (
    <div className="filter-field">
      <label htmlFor={id}>{label}</label>
      <div className="select-wrap">
        <select id={id} value={value} onChange={event => update(name, event.target.value)}>
          <option value="">{name === 'lifecycleStatus' ? 'Open or unknown' : 'All'}</option>
          {value && !options.some(([key]) => key === value) && <option value={value}>{value}</option>}
          {options.map(([key, title]) => <option key={key} value={key}>{title}</option>)}
        </select>
      </div>
    </div>
  );
}

function getOptions(key, values) {
  if (key === 'lifecycleStatus') return availability;
  const labels = key === 'state' ? stateNames : key === 'governmentLevel' ? levelNames : {};
  return (values ?? []).map(value => [value, Object.hasOwn(labels, value) ? labels[value]
    : ['category', 'benefitType'].includes(key) ? displayLabel(value) : value]);
}

export function CataloguePage({ answers, setAnswers }) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const [panelOpen, setPanelOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const personalizeButton = useRef(null);
  const resultsHeading = useRef(null);
  const apiParams = new URLSearchParams([...params].filter(([key]) => permittedKeys.has(key)));
  apiParams.sort();

  const catalogue = useQuery({
    queryKey: ['catalogue', apiParams.toString()],
    queryFn: ({ signal }) => readCatalogue('/schemes?' + apiParams, signal),
  });
  const facets = useQuery({
    queryKey: ['facets'],
    queryFn: ({ signal }) => readCatalogue('/facets', signal),
  });

  const results = catalogue.data?.items ?? [];
  const schemeIds = results.map(scheme => scheme._id).join(',');
  const questions = useQuery({
    queryKey: ['questions', schemeIds],
    queryFn: ({ signal }) => readCatalogue('/questions?' + new URLSearchParams({ schemeIds }), signal),
    enabled: Boolean(schemeIds && (panelOpen || answers !== null)),
  });
  const personalization = usePersonalization(schemeIds, questions.isError ? undefined : questions.data?.questions, answers);
  const matchById = new Map(personalization.matches?.map(match => [match.schemeId, match]));
  const positionById = new Map(personalization.matches?.map((match, index) => [match.schemeId, index]));
  const orderedResults = personalization.matches ? [...results].sort((left, right) =>
    (positionById.get(left._id) ?? results.length) - (positionById.get(right._id) ?? results.length)
  ) : results;

  function update(name, value) {
    const next = new URLSearchParams(params);
    if (name !== 'page') next.delete('page');
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next);
  }

  function search(event) {
    event.preventDefault();
    update('q', String(new FormData(event.currentTarget).get('q')).trim());
    resultsHeading.current?.focus();
  }

  function chooseCategory(category) {
    update('category', category === params.get('category') ? '' : category);
    resultsHeading.current?.focus();
  }

  const activeFilters = [...filterFields.map(([key]) => key), 'goal'].filter(key => params.has(key)).length;
  const pagination = catalogue.data?.pagination;
  const total = pagination?.total;

  return (
    <>
      <section className="hero">
        <div className="shell hero-inner">
          <div className="hero-copy">
            <p className="hero-eyebrow">Indian government schemes</p>
            <h1>Find government support <span>that fits your needs.</span></h1>
            <p className="hero-lede">Explore central and state schemes, compare benefits, and check requirements before you apply.</p>
            <form role="search" onSubmit={search} className="search-form" key={params.get('q')}>
              <label htmlFor="scheme-search" className="sr-only">Search schemes</label>
              <span className="search-icon" aria-hidden="true" />
              <input id="scheme-search" name="q" type="search" maxLength={160}
                placeholder="Try solar, books, or training" defaultValue={params.get('q') ?? ''} />
              <button className="primary-button" type="submit">Search</button>
            </form>
            {facets.data?.categories?.length > 0 && (
              <div className="quick-categories" role="group" aria-label="Browse by category">
                {facets.data.categories.slice(0, 3).map(category => (
                  <button key={category} type="button" aria-pressed={params.get('category') === category}
                    onClick={() => chooseCategory(category)}>{displayLabel(category)}</button>
                ))}
              </div>
            )}
          </div>
          <div className="hero-visual" aria-hidden="true" />
        </div>
      </section>
      <div className="shell catalogue-layout">
        <aside className="filters" aria-labelledby="filters-heading">
          <div className="filter-heading">
            <h2 id="filters-heading">Filters</h2>
            <button className="filter-toggle" type="button" aria-controls="catalogue-filters" aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen(open => !open)}>Filters{activeFilters > 0 && ` (${activeFilters})`}</button>
            {activeFilters > 0 && <button className="text-link" type="button" onClick={() => {
              const next = new URLSearchParams(params);
              for (const [field] of filterFields) next.delete(field);
              next.delete('goal');
              next.delete('page');
              setParams(next);
            }}>Clear filters</button>}
          </div>
          <div className="filter-options" id="catalogue-filters" data-open={filtersOpen}>
            {facets.isError && <p className="muted">Some filter options are unavailable.</p>}
            {filterFields.map(([key, label, facet]) => (
              <FilterSelect key={key} name={key} label={label} options={getOptions(key, facets.data?.[facet])}
                value={params.get(key) ?? ''} update={update} />
            ))}
            <p className="filter-hint">A state selection also includes nationwide central schemes.</p>
          </div>
        </aside>
        <section className="results" aria-labelledby="results-heading">
          <div className="results-heading">
            <div><h2 id="results-heading" ref={resultsHeading} tabIndex={-1}>Explore schemes</h2>
              {total !== undefined && <p role="status">{total} {total === 1 ? 'result' : 'results'}{params.get('q') && ` for “${params.get('q')}”`}</p>}
            </div>
            <div className="personalize-actions">
              <button className="secondary-button" type="button" aria-haspopup="dialog" ref={personalizeButton}
                disabled={!schemeIds} onClick={() => setPanelOpen(true)}>Personalize Results</button>
              {answers !== null && <button className="text-link" type="button" onClick={() => {
                setAnswers(null);
                (personalizeButton.current?.disabled ? resultsHeading : personalizeButton).current?.focus();
              }}>Reset personalization</button>}
            </div>
          </div>
          {answers !== null && schemeIds && (
            <div className="personalization-note">
              {questions.isError || personalization.error ? (
                <p role="alert">Personalization is unavailable. Showing ordinary results.{' '}
                  <button className="text-link" type="button"
                    onClick={() => questions.isError ? questions.refetch() : personalization.retry()}>
                    Retry personalization
                  </button>
                </p>
              ) : (
                <p role="status">{questions.isPending || personalization.pending
                  ? 'Checking your answers…'
                  : 'Results on this page are ranked using your answers. Matches are estimates; the issuer confirms eligibility.'}</p>
              )}
            </div>
          )}
          {catalogue.isPending && <div className="empty-state" role="status"><p>Loading schemes…</p>
            <div className="skeleton-lines" aria-hidden="true"><span /><span /><span /></div></div>}
          {catalogue.isError && (
            <div role="alert" className="empty-state">
              <h3>Unable to load schemes</h3>
              <p>{catalogue.error.message}</p>
              <button type="button" className="secondary-button" onClick={() => catalogue.refetch()}>Retry</button>
              {params.size > 0 && <button type="button" className="text-link" onClick={() => setParams({})}>Reset search</button>}
            </div>
          )}
          {catalogue.isSuccess && results.length === 0 && (
            <div className="empty-state">
              <h3>{params.size > 0 ? 'No schemes found' : dataset === 'synthetic' ? 'No demo schemes loaded' : 'The catalogue is empty'}</h3>
              {params.size > 0
                ? <><p>Try a different keyword or broaden your filters.</p><button type="button" className="text-link" onClick={() => setParams({})}>Reset search</button></>
                : <p>Listings appear here once source-backed records are imported.</p>}
            </div>
          )}
          {results.length > 0 && (
            <div className="results-list">
              {orderedResults.map(scheme => <SchemeCard key={scheme._id} scheme={scheme}
                match={matchById.get(scheme._id)} returnTo={location.search} />)}
            </div>
          )}
          {pagination && (pagination.totalPages > 1 || pagination.page > 1) && (
            <nav className="pagination" aria-label="Result pages">
              <button className="secondary-button" type="button" disabled={pagination.page <= 1}
                onClick={() => update('page', String(pagination.page - 1))}>Previous</button>
              <span>Page {pagination.page} of {pagination.totalPages || 1}</span>
              <button className="secondary-button" type="button" disabled={pagination.page >= pagination.totalPages}
                onClick={() => update('page', String(pagination.page + 1))}>Next</button>
            </nav>
          )}
        </section>
      </div>
      {panelOpen && <PersonalizePanel questions={questions} answers={answers} onApply={setAnswers}
        onClose={() => {
          setPanelOpen(false);
          personalizeButton.current?.focus();
        }} />}
    </>
  );
}
