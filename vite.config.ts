import { defineConfig, loadEnv } from "vite";
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const api = `http://127.0.0.1:${process.env.API_PORT || env.API_PORT || 3001}`;
  return {
    server: {
      proxy: {
        "/api": { target: api, changeOrigin: false },
        "/v1": { target: api, changeOrigin: false },
      },
    },
  };
});
