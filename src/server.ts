import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const API_KEY = process.env.BRAVE_API_KEY;
if (!API_KEY) {
  throw new Error('BRAVE_API_KEY environment variable is required');
}

const PORT = process.env.PORT || 3001;

// Store active SSE clients
const clients = new Set<Response>();

class BraveSearchServer {
  private server: Server;
  private expressApp: express.Express;

  constructor() {
    this.server = new Server(
      {
        name: 'brave-search-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.expressApp = express();
    this.expressApp.use(cors());
    this.expressApp.use(express.json());

    this.setupToolHandlers();
    this.setupSSEEndpoints();
    
    // Error handling
    this.server.onerror = (error) => this.broadcastError(error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'brave_web_search',
          description: 'Performs a web search using the Brave Search API with SSE support',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query (max 400 chars, 50 words)',
              },
              count: {
                type: 'number',
                description: 'Number of results (1-20, default 10)',
                default: 10,
              },
            },
            required: ['query'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== 'brave_web_search') {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}`
        );
      }

      const { query, count = 10 } = request.params.arguments as {
        query: string;
        count?: number;
      };

      try {
        const searchParams = new URLSearchParams({
          q: query,
          count: Math.min(Math.max(1, count), 20).toString()
        });

        const response = await fetch(
          `https://api.search.brave.com/res/v1/web/search?${searchParams}`,
          {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
              'Accept-Encoding': 'gzip',
              'X-Subscription-Token': API_KEY || ''
            }
          }
        );

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const results = await response.json();
        
        // Broadcast results to all connected SSE clients
        this.broadcast(results);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.broadcastError(errorMessage);
        throw new McpError(ErrorCode.InternalError, errorMessage);
      }
    });
  }

  private setupSSEEndpoints() {
    // SSE endpoint
    this.expressApp.get('/sse', (req: Request, res: Response) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      // Send initial connection established message
      res.write('data: {"type":"connected"}\n\n');

      // Add client to active connections
      clients.add(res);

      // Remove client on connection close
      req.on('close', () => {
        clients.delete(res);
      });
    });

    // Messages endpoint for manual search requests
    this.expressApp.post('/messages', async (req: Request, res: Response) => {
      try {
        const { query, count } = req.body;
        // Handle the search request directly
        const response = await fetch(
          `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({
            q: query,
            count: Math.min(Math.max(1, count || 10), 20).toString()
          })}`,
          {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
              'Accept-Encoding': 'gzip',
              'X-Subscription-Token': API_KEY || ''
            }
          }
        );

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const results = await response.json();
        res.json(results);
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });
  }

  private broadcast(data: unknown) {
    const message = `data: ${JSON.stringify(data)}\n\n`;
    clients.forEach(client => {
      client.write(message);
    });
  }

  private broadcastError(error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const message = `data: ${JSON.stringify({ type: 'error', error: errorMessage })}\n\n`;
    clients.forEach(client => {
      client.write(message);
    });
  }

  async run() {
    // Start Express server
    this.expressApp.listen(PORT, () => {
      console.error(`SSE server running on port ${PORT}`);
    });

    // Start MCP server
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Brave Search MCP server running on stdio');
  }
}

const server = new BraveSearchServer();
server.run().catch(console.error);
