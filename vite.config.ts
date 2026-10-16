import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import { isIP } from "node:net";
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const admin = process.env.VITE_PORTAL === "admin";
  const provider=process.env.VITE_PORTAL === "provider";
  const api = `http://127.0.0.1:${provider ? process.env.PROVIDER_API_PORT || env.PROVIDER_API_PORT || 3003 : admin ? process.env.ADMIN_API_PORT || env.ADMIN_API_PORT || 3002 : process.env.API_PORT || env.API_PORT || 3001}`;
  const proxy:ProxyOptions={target:api,changeOrigin:false,configure(server){server.on("proxyReq",(upstream,req)=>{
    const local=["127.0.0.1","::ffff:127.0.0.1","::1"].includes(req.socket.remoteAddress || "");
    const secure=local && req.headers["x-corematrix-proto"]==="https";
    const client=req.headers["x-corematrix-client-ip"];
    for(const name of ["forwarded","x-real-ip","x-forwarded-for","x-forwarded-proto","x-corematrix-client-ip","x-corematrix-proto"]) upstream.removeHeader(name);
    upstream.setHeader("X-Forwarded-Proto",secure?"https":"http");
    upstream.setHeader("X-Forwarded-For",secure && typeof client==="string" && isIP(client)?client:req.socket.remoteAddress || "127.0.0.1");
  });}};
  return {
    build:{outDir:`dist/${provider?"provider":admin?"admin":"user"}`},
    server: {
      port: provider ? 5175 : admin ? 5174 : 5173,
      strictPort: true,
      proxy: {
        "/api": proxy,
        "/v1": proxy,
      },
    },
  };
});
