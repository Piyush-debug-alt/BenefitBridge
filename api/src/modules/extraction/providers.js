import { analyzeSource } from './evidence.js';
import { geminiProvider } from './gemini.js';

// A hosted adapter can implement this interface and return the same JSON proposal.
export const mockProvider = Object.freeze({
  id: 'mock', version: 'explicit-en-v1',
  async extract({ text }) {
    return { paths: analyzeSource(text).paths };
  },
});

export function configuredExtractionProvider(name = 'off', get = key => process.env[key], options) {
  if (name === 'off') return null;
  if (name === 'mock') return mockProvider;
  if (name === 'gemini') return geminiProvider(get, options);
  throw new Error('Set AI_EXTRACTION_PROVIDER to off, mock, or gemini.');
}

export async function extractProposal(provider, input) {
  if (provider.extractWithDiagnostics) return provider.extractWithDiagnostics(input);
  return { proposal: await provider.extract(input) };
}
