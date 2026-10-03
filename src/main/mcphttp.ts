import * as http from 'http';
import { randomBytes } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { TaskEngine } from './engine';
import { registerOrchestraTools, registerMemoryTools, ORCHESTRA_INSTRUCTIONS } from '../mcp/tools';

export interface McpHttpHost {
  url: string;
  token: string;
  close: () => Promise<void>;
}

/**
 * Serve the Orchestra tools for one run over MCP Streamable HTTP on 127.0.0.1, bound to the app's own TaskEngine.
 * The subscription orchestrator (Claude Code or Codex, started by the app) connects here, so the UI sees every task live
 * and manual merge/discard, budgets and history work exactly as with the API orchestrator.
 * Stateless: every POST gets a fresh server + transport; the tools close over the same engine.
 */
export async function startMcpHttp(engine: TaskEngine, waitSec = 240): Promise<McpHttpHost> {
  const token = randomBytes(24).toString('hex');
  const srv = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== 'POST') {
      // Stateless server: no SSE stream for server-initiated messages.
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      const server = new McpServer({ name: 'orchestra', version: '0.7.5' }, { instructions: ORCHESTRA_INSTRUCTIONS(engine.state.repo) });
      registerOrchestraTools(server, { engine, repo: engine.state.repo, waitSec });
      registerMemoryTools(server, engine.state.repo, 'orchestra', () => engine.cfg);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req as any, res, body ? JSON.parse(body) : undefined);
      } catch (e: any) {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: e?.message ?? String(e) }, id: null }));
      }
    });
  });
  // Long waits are the point of wait_for.
  srv.requestTimeout = 0;
  srv.headersTimeout = 0;
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as any).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}
