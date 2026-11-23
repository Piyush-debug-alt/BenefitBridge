export const dataset = import.meta.env.MODE === 'demo' ? 'synthetic' : 'authorized';

export async function readCatalogue(path, signal) {
  const response = await fetch('/api/v1' + path, { signal });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.message ?? 'The catalogue is currently unavailable.');
    error.status = response.status;
    throw error;
  }
  if (data?.dataset !== dataset) {
    throw new Error('The catalogue is connected to a different data environment.');
  }
  return data;
}
