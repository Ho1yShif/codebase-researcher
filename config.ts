import { defineConfig } from "./src/types.ts";

// The example corpus is three public repositories, so a fresh deploy answers real questions
// before you change anything. Replace them with your own.
export default defineConfig({
  name: "Code Investigator",
  repos: [
    { repository: "render-oss/cli" },
    { repository: "render-oss/sdk" },
    { repository: "render-oss/skills" },
  ],
  gitCredentials: {
    "github.com": { username: "x-access-token", tokenEnv: "GITHUB_TOKEN" },
  },
  labels: {
    owner: "Suggested owner",
    escalation: "Question for engineering",
    supportTeam: "the support team",
  },
  snapshotName: "code-investigator-corpus",
});
