// MCP smoke test: connects to the in-cluster MCP server (port-forwarded) as a given Teleport user and
// exercises the read tools. Usage:
//   MCP_URL=http://localhost:8080/mcp MCP_SHARED_TOKEN=... node tests/teleport/mcp/smoke.mjs alice
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const user = process.argv[2] ?? "alice";
const url = process.env.MCP_URL ?? "http://localhost:8080/mcp";
const token = process.env.MCP_SHARED_TOKEN;
if (!token) throw new Error("MCP_SHARED_TOKEN required (pulumi stack output mcpSharedToken --show-secrets)");

const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}`, "X-Teleport-User": user, "X-Teleport-User-Email": `${user}@example.com` } } }));
const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`, tools.map((t) => t.name).join(", "));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  console.log(`\n== ${name} ${JSON.stringify(args)} ${r.isError ? "(ERROR)" : ""}\n${text.slice(0, 900)}`);
  return r;
};
await call("whoami");
await call("list_requestable_roles");
await call("search_resources", { query: "ssh-prod-0" });
await call("explain_access", { resource_name: "postgres-prod" });
await call("who_can_approve", { role: "prod-ssh" });
await call("list_accessible_resources");
await call("get_approval_policy", { roles: ["dev-ssh"], ttl: "1h" });
await client.close();
