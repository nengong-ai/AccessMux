export function fixtureUiResponse(input: RequestInfo | URL): Response | undefined {
  const path = new URL(String(input)).pathname;
  if (path === '/ui' || path === '/ui/') return new Response('<html><title>AccessMux fixture</title></html>', { headers: { 'content-type': 'text/html' } });
  if (path === '/ui/app.js') return new Response('console.log("fixture");', { headers: { 'content-type': 'application/javascript' } });
  if (path === '/ui/style.css') return new Response('body { color: black; }', { headers: { 'content-type': 'text/css' } });
  return undefined;
}
