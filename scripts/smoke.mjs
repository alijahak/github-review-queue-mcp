// Read-only smoke test against the real GitHub API over stdio. Never calls a write tool.
//   GITHUB_TOKEN=$(gh auth token) node scripts/smoke.mjs owner/repo pr-number
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const [repo, number] = process.argv.slice(2);
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: ["dist/stdio.js"],
  env: { ...getDefaultEnvironment(), GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "" },
}));
try {
  const queue = await client.callTool({ name: "list_review_requests", arguments: { limit: 5 } });
  console.log("list_review_requests:", queue.isError ? queue.content[0].text : `${queue.structuredContent.count} open review request(s)`);
  if (repo && number) {
    const pr = await client.callTool({ name: "get_pull_request", arguments: { repo, number: Number(number) } });
    const p = pr.structuredContent;
    console.log("get_pull_request:", pr.isError ? pr.content[0].text : `${p.title} | +${p.additions}/-${p.deletions} in ${p.changed_files} files | reviews: ${p.reviews.length}`);
    const files = await client.callTool({ name: "list_pull_request_files", arguments: { repo, number: Number(number), limit: 5 } });
    console.log("list_pull_request_files:", files.isError ? files.content[0].text : files.structuredContent.files.map((f) => f.filename).join(", "));
    const checks = await client.callTool({ name: "get_pull_request_checks", arguments: { repo, number: Number(number) } });
    console.log("get_pull_request_checks:", checks.isError ? checks.content[0].text : `${checks.structuredContent.overall} ${JSON.stringify(checks.structuredContent.counts)}`);
  }
  const missing = await client.callTool({ name: "get_pull_request", arguments: { repo: "octocat/this-repo-does-not-exist", number: 1 } });
  console.log("error path:", missing.content[0].text);
} finally {
  await client.close();
}
