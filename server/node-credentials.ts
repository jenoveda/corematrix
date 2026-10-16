import { createHmac } from "node:crypto";
import type { Store } from "./store.ts";
export const NODE_INFERENCE_KEY = "INFERENCE_COREMATRIX_NODE_INFERENCE";
export const NODE_WORKSPACE_KEY = "INFERENCE_COREMATRIX_NODE_WORKSPACE";
export function nodeCredentials(seed: string) {
  const derive=(purpose:string)=>createHmac("sha256",seed).update("corematrix-node-v1:"+purpose).digest("hex");
  return {inference:derive("inference"),workspace:derive("workspace")};
}
export function runtimeCredential(store: Store, serverId: string, name: string) {
  if (![NODE_INFERENCE_KEY,NODE_WORKSPACE_KEY].includes(name)) return process.env[name];
  const node=store.get<{credentialSeed:string|null;capabilities:string}>("SELECT credentialSeed,capabilities FROM servers WHERE id=?",serverId);
  if(!node?.credentialSeed || JSON.parse(node.capabilities).nodeScopedKeys!==true) return undefined;
  const keys=nodeCredentials(node.credentialSeed);
  return name===NODE_INFERENCE_KEY?keys.inference:keys.workspace;
}
