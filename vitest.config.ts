import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      "@agent-platform/contracts": "/home/openclaw/agent-platform/packages/contracts/src/index.ts",
      "@agent-platform/core": "/home/openclaw/agent-platform/packages/core/src/index.ts",
      "@agent-platform/frontdesk": "/home/openclaw/agent-platform/packages/frontdesk/src/index.ts",
      "@agent-platform/memory-fabric": "/home/openclaw/agent-platform/packages/memory-fabric/src/index.ts",
      "@agent-platform/bundle-builder": "/home/openclaw/agent-platform/packages/bundle-builder/src/index.ts",
      "@agent-platform/memory-service": "/home/openclaw/agent-platform/packages/memory-service/src/index.ts",
      "@agent-platform/model-gateway": "/home/openclaw/agent-platform/packages/model-gateway/src/index.ts",
      "@agent-platform/secrets-service": "/home/openclaw/agent-platform/packages/secrets-service/src/index.ts",
      "@agent-platform/supervisor-runtime": "/home/openclaw/agent-platform/packages/supervisor-runtime/src/index.ts",
      "@agent-platform/integrations": "/home/openclaw/agent-platform/packages/integrations/src/index.ts",
      "@agent-platform/policy-engine": "/home/openclaw/agent-platform/packages/policy-engine/src/index.ts",
      "@agent-platform/codex-runtime": "/home/openclaw/agent-platform/packages/codex-runtime/src/index.ts",
      "@agent-platform/supervisor": "/home/openclaw/agent-platform/packages/supervisor/src/index.ts",
      "@agent-platform/observability": "/home/openclaw/agent-platform/packages/observability/src/index.ts"
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"]
  }
});
