import { analyzeSource } from './evidence.js';

// A hosted adapter can implement this interface and return the same JSON proposal.
export const mockProvider = Object.freeze({
  id: 'mock', version: 'explicit-en-v1',
  async extract({ text }) {
    return { paths: analyzeSource(text).paths };
  },
});

export function configuredExtractionProvider(name = 'off') {
  if (name === 'off') return null;
  if (name === 'mock') return mockProvider;
  throw new Error('Set AI_EXTRACTION_PROVIDER to off or mock.');
}
