/**
 * Test doubles: a fetch that routes URLs to handlers, and an in-memory
 * Airtable that speaks just enough of the REST API for lib/airtable.mjs.
 */

export const json = (body, status = 200, url = '') => ({
  ok: status >= 200 && status < 300,
  status,
  url,
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

export const html = (body, url = '') => json(body, 200, url);

/**
 * routes: [[test, handler]] where test is a string prefix or a RegExp and
 * handler is (url, init) => response. Unmatched URLs 404.
 */
export function router(routes, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body });
    for (const [test, handler] of routes) {
      if (typeof test === 'string' ? url.startsWith(test) : test.test(url)) return handler(url, init);
    }
    return json({ error: 'not found' }, 404, url);
  };
}

export function fakeAirtable(seed = {}) {
  const tables = Object.fromEntries(Object.entries(seed).map(([t, rows]) => [t, rows.map((r, i) => ({
    id: r.id ?? `rec${t.replace(/\W/g, '')}${i}`, fields: { ...(r.fields ?? r) },
  }))]));
  let n = 0;

  const handler = async (url, init) => {
    const u = new URL(url);
    const table = decodeURIComponent(u.pathname.split('/')[3]);
    tables[table] ??= [];
    const rows = tables[table];
    const method = init.method ?? 'GET';
    if (method === 'GET') {
      const size = Number(u.searchParams.get('pageSize') ?? 100);
      const start = Number(u.searchParams.get('offset') ?? 0);
      const want = u.searchParams.getAll('fields[]');
      const page = rows.slice(start, start + size).map(r => ({
        id: r.id,
        fields: want.length ? Object.fromEntries(Object.entries(r.fields).filter(([k]) => want.includes(k))) : r.fields,
      }));
      return json({ records: page, ...(start + size < rows.length ? { offset: String(start + size) } : {}) });
    }
    const body = JSON.parse(init.body);
    if (body.records.length > 10) return json({ error: 'too many records' }, 422);
    if (method === 'POST') {
      const created = body.records.map(r => ({ id: `recNew${++n}`, fields: { ...r.fields } }));
      rows.push(...created);
      return json({ records: created });
    }
    if (method === 'PATCH') {
      for (const r of body.records) {
        const row = rows.find(x => x.id === r.id);
        if (!row) return json({ error: `no ${r.id}` }, 404);
        for (const [k, v] of Object.entries(r.fields)) {
          if (v === null) delete row.fields[k]; else row.fields[k] = v;
        }
      }
      return json({ records: body.records });
    }
    return json({ error: 'bad method' }, 405);
  };

  return { tables, handler };
}
