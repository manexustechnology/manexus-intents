import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const port = env.PORT ? Number(env.PORT) : undefined;
  const allowedHosts = env.ALLOWED_HOSTS ? env.ALLOWED_HOSTS.split(",").map((host) => host.trim()).filter(Boolean) : undefined;

  // `npm run dev:api` serves the built app and /api on API_PORT (default 24011). Vite's dev server forwards
  // /api there too, so `npm run dev` gives live reload with a working API on the same origin.
  const api = `http://127.0.0.1:${env.API_PORT || "24011"}`;

  return {
    server: { port, strictPort: port !== undefined, allowedHosts, proxy: { "/api": { target: api } } },
    preview: { port, strictPort: port !== undefined, allowedHosts },
  };
});
