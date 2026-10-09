// Writes the repository-SHA manifest (contracts RepoManifest) once the repos are checked out.
// Usage: node write-manifest.mjs <heads.tsv> <profile> <created_at> <repos_root>
import { readFileSync } from "node:fs";

const [headsFile, profile, createdAt, reposRoot] = process.argv.slice(2);
const repos = readFileSync(headsFile, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [repository, branch, commit, url, browse] = line.split("\t");
    const entry = { repository, branch, commit, path: `${reposRoot}/${repository}` };
    if (url) entry.url = url;
    if (browse) entry.browse = browse;
    return entry;
  });
process.stdout.write(`${JSON.stringify({ profile, created_at: createdAt, repos }, null, 2)}\n`);
