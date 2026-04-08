import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      "@agent-platform/contracts": "/home/user/agent-platform/packages/contracts/src/index.ts",
      "@agent-platform/core": "/home/user/agent-platform/packages/core/src/index.ts",
      "@agent-platform/frontdesk": "/home/user/agent-platform/packages/frontdesk/src/index.ts",
      "@agent-platform/memory-fabric": "/home/user/agent-platform/packages/memory-fabric/src/index.ts",
      "@agent-platform/bundle-builder": "/home/user/agent-platform/packages/bundle-builder/src/index.ts",
      "@agent-platform/memory-service": "/home/user/agent-platform/packages/memory-service/src/index.ts",
      "@agent-platform/model-gateway": "/home/user/agent-platform/packages/model-gateway/src/index.ts",
      "@agent-platform/secrets-service": "/home/user/agent-platform/packages/secrets-service/src/index.ts",
      "@agent-platform/supervisor-runtime": "/home/user/agent-platform/packages/supervisor-runtime/src/index.ts",
      "@agent-platform/integrations": "/home/user/agent-platform/packages/integrations/src/index.ts",
      "@agent-platform/policy-engine": "/home/user/agent-platform/packages/policy-engine/src/index.ts",
      "@agent-platform/codex-runtime": "/home/user/agent-platform/packages/codex-runtime/src/index.ts",
      "@agent-platform/supervisor": "/home/user/agent-platform/packages/supervisor/src/index.ts",
      "@agent-platform/observability": "/home/user/agent-platform/packages/observability/src/index.ts"
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"]
  }
});
