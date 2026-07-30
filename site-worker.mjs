export default {
  async fetch(request, environment) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/seed" || pathname.startsWith("/seed/")) {
      return new Response("Gone\n", {
        status: 410,
        headers: {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
          "x-robots-tag": "noindex",
        },
      });
    }
    if (!environment?.ASSETS?.fetch) {
      return new Response("Static asset binding unavailable.\n", { status: 503 });
    }
    return environment.ASSETS.fetch(request);
  },
};
