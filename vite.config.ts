import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const port = env.PORT ? Number(env.PORT) : undefined;
  const allowedHosts = env.ALLOWED_HOSTS ? env.ALLOWED_HOSTS.split(",").map((host) => host.trim()).filter(Boolean) : undefined;

  return {
    server: { port, strictPort: port !== undefined, allowedHosts },
    preview: { port, strictPort: port !== undefined, allowedHosts },
  };
});
