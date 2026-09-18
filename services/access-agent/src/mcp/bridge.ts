/**
 * MCP tools -> Claude runnable tools, via the Anthropic SDK's MCP helper, plus input validation
 * (eager input streaming disables server-side validation, so we validate here before calling MCP).
 */
import { mcpTools } from "@anthropic-ai/sdk/helpers/beta/mcp";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Ajv } from "ajv";
import type { McpTool } from "./client.js";

const ajv = new Ajv({ allErrors: true, strict: false });

export function bridgeTools(tools: McpTool[], client: Client): BetaRunnableTool[] {
  const runnable = mcpTools(tools as any, client as any, { eager_input_streaming: true } as any);
  return runnable.map((tool, i) => {
    const validate = ajv.compile(tools[i].inputSchema as object);
    const inner = tool.run;
    return {
      ...tool,
      run: async (args: Record<string, unknown>, ctx?: any) => {
        if (!validate(args)) {
          return JSON.stringify({ INVALID_INPUT: ajv.errorsText(validate.errors), input: args });
        }
        return inner(args, ctx);
      },
    } as BetaRunnableTool;
  });
}
