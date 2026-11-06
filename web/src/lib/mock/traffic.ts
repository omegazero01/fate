import type { TrafficExchange } from '../types';

// Only in-memory demo records. Never contacts a target or the production API.
export function createMockTraffic(seed: TrafficExchange[]) {
  let rows = structuredClone(seed);
  const group = (values: string[]) => Object.entries(values.reduce<Record<string, number>>((a, key) => {
    a[key] = (a[key] ?? 0) + 1; return a;
  }, {}));
  const integer = (value: string | null, fallback: number, min: number) => {
    const n = value === null ? fallback : Number(value);
    return Number.isInteger(n) && n >= min ? n : fallback;
  };
  return {
    hosts: () => ({ hosts: group(rows.map(r => r.host)).map(([host, count]) => ({ host, count })) }),
    paths(q: URLSearchParams) {
      const paths = group(rows.filter(r => r.host === q.get('host')).map(r => new URL(r.url).pathname))
        .map(([path, count]) => ({ path, count }));
      const page = integer(q.get('page'), 0, 0), size = 100;
      return { paths: paths.slice(page * size, (page + 1) * size), total: paths.length, page, size };
    },
    page(q: URLSearchParams) {
      const matches = rows.filter(r =>
        (!q.get('host') || r.host === q.get('host')) &&
        (!q.get('method') || r.method === q.get('method')) &&
        (!q.get('status') || String(r.status) === q.get('status')) &&
        (!q.get('status_class') || String(Math.floor(r.status / 100)) === q.get('status_class')) &&
        (!q.get('path_exact') || new URL(r.url).pathname === q.get('path_exact')) &&
        (!q.get('q') || r.url.toLowerCase().includes(q.get('q')!.toLowerCase())));
      const page = integer(q.get('page'), 0, 0), size = Math.min(1000, integer(q.get('size'), 50, 1));
      return { enabled: true, count: rows.length, total: matches.length, page, size,
        exchanges: matches.slice(page * size, (page + 1) * size) };
    },
    remove(host?: string, hosts?: string[]) {
      const before = rows.length;
      rows = rows.filter(r => hosts ? !hosts.includes(r.host) : host ? r.host !== host : false);
      return { deleted: before - rows.length, reclaimed: 0 };
    },
  };
}
