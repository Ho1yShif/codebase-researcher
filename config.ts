import { defineConfig } from "./src/bot-config.ts";

// The example corpus is three public repositories, so a fresh deploy answers real questions
// before you change anything. Replace them with your own.
export default defineConfig({
  name: "Codebase Researcher",
  repos: [
    { repository: "render-oss/cli" },
    { repository: "render-oss/sdk" },
    { repository: "render-oss/skills" },
  ],
  gitCredentials: {
    "github.com": { username: "x-access-token", tokenEnv: "GITHUB_TOKEN" },
  },
  snapshotName: "codebase-researcher-corpus",
});
