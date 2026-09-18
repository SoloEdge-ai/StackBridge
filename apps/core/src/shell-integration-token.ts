import { createHash } from "node:crypto";

export function dockerShellIntegrationToken(rootToken: string): string {
  return createHash("sha256")
    .update(`${rootToken}:docker-command-scope`, "utf8")
    .digest("base64url");
}
