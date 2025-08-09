import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new Server(
  {
    name: "mcp-post-commit",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.tool(
  "postCommit",
  {
    description: "Tool intended to be triggered after a Git commit. Returns 'OK' for now.",
    inputSchema: z
      .object({})
      .describe("No inputs required. This is a placeholder tool returning 'OK'."),
  },
  async () => {
    return {
      content: [{ type: "text", text: "OK" }],
    };
  }
);

const transport = new StdioServerTransport();
server.connect(transport);

