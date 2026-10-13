/**
 * Yahoo endpoints.  On the phone the app calls Yahoo directly; a browser preview cannot (no CORS headers), so
 * the web build points these at the development proxy in scripts/dev-proxy.js via `useProxy()`.
 */
export const NET = {
  query: ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'],
  cookie: 'https://fc.yahoo.com',
};
export function useProxy(base: string) {
  NET.query = [`${base}/q1`, `${base}/q2`];
  NET.cookie = `${base}/fc`;
}
