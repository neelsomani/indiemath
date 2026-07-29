export default {
  async fetch(request, environment) {
    if (!environment?.ASSETS?.fetch) {
      return new Response("Static asset binding unavailable.\n", { status: 503 });
    }
    return environment.ASSETS.fetch(request);
  },
};
