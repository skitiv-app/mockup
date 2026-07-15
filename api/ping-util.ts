export default async function handler(_req: any, res: any) {
  res.setHeader("content-type", "application/json");
  try {
    const m: any = await import("./_lib/util");
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, slug: m.slug("Hello World") }));
  } catch (e: any) {
    res.statusCode = 500;
    res.end(JSON.stringify({ err: String((e && e.stack) || e) }));
  }
}
