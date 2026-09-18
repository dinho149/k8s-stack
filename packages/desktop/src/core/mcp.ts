import { createServer, createConnection, type Server } from 'node:net';
import { createInterface } from 'node:readline';
import { chmod, unlink } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { toolDefinitions, type ToolCall } from './harness';

export async function serveTools(
  path: string,
  token: string,
  dispatch: (runId: string, name: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<Server> {
  await unlink(path).catch(() => {});
  const server = createServer((socket) => {
    socket.setTimeout(300000, () => socket.destroy());
    let length = 0;
    socket.on('data', (data) => {
      length += data.length;
      if (length > 2_000_000) socket.destroy();
    });
    createInterface({ input: socket }).on('line', (line) => {
      void (async () => {
        try {
          const request = JSON.parse(line),
            supplied = Buffer.from(String(request.token ?? '')),
            expected = Buffer.from(token);
          if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
            throw new Error('Unauthorized tool request');
          const definition = toolDefinitions.find((t) => t.name === request.name);
          if (!definition) throw new Error('Unknown tool');
          const result = await dispatch(
            request.runId,
            request.name,
            definition.schema.parse(request.args),
          );
          socket.end(JSON.stringify({ result }) + '\n');
        } catch (error) {
          socket.end(JSON.stringify({ error: String(error) }) + '\n');
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve());
  });
  await chmod(path, 0o600);
  return server;
}
export function mcpMain(path: string, runId: string) {
  const respond = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n');
  createInterface({ input: process.stdin }).on('line', (line) => {
    void (async () => {
      let request: any;
      try {
        request = JSON.parse(line);
        if (request.id === undefined) return;
        let result: unknown;
        if (request.method === 'initialize')
          result = {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'dogfood', version: '1.0.0' },
          };
        else if (request.method === 'tools/list')
          result = {
            tools: toolDefinitions.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: z.toJSONSchema(t.schema),
            })),
          };
        else if (request.method === 'tools/call') {
          const value = await new Promise<unknown>((resolve, reject) => {
            const socket = createConnection(path);
            let text = '';
            socket.on('error', reject);
            socket.setTimeout(300000, () => {
              socket.destroy();
              reject(new Error('Tool timed out'));
            });
            socket.on('connect', () =>
              socket.write(
                JSON.stringify({
                  token: process.env.DOGFOOD_MCP_TOKEN,
                  runId,
                  name: request.params.name,
                  args: request.params.arguments,
                }) + '\n',
              ),
            );
            socket.on('data', (data) => {
              text += data;
            });
            socket.on('end', () => {
              try {
                const response = JSON.parse(text);
                response.error ? reject(new Error(response.error)) : resolve(response.result);
              } catch (error) {
                reject(error);
              }
            });
          });
          result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
        } else if (request.method === 'ping') result = {};
        else throw new Error('Unknown method');
        respond({ jsonrpc: '2.0', id: request.id, result });
      } catch (error) {
        respond({
          jsonrpc: '2.0',
          id: request?.id ?? null,
          error: { code: -32603, message: String(error) },
        });
      }
    })();
  });
}
