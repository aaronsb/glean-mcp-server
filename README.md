# @gleanwork/mcp-server

![](https://badge.mcpx.dev?type=server 'MCP Server')
![CI Build](https://github.com/gleanwork/mcp-server/actions/workflows/ci.yml/badge.svg)
[![npm version](https://badge.fury.io/js/%40gleanwork%2Fmcp-server.svg)](https://badge.fury.io/js/%40gleanwork%2Fmcp-server)
[![License](https://img.shields.io/npm/l/@gleanwork%2Fmcp-server.svg)](https://github.com/gleanwork/mcp-server/blob/main/LICENSE)

A Model Context Protocol (MCP) server implementation for Glean's search and chat capabilities. This server provides a standardized interface for AI models to interact with Glean's content search and conversational AI features through stdio communication.

## Features

- 🔍 **Search Integration**: Access Glean's powerful content search capabilities
- 💬 **Chat Interface**: Interact with Glean's AI assistant
- 🔄 **MCP Compliant**: Implements the Model Context Protocol specification

## Prerequisites

- Node.js v18 or higher
- Glean API credentials

## Installation

With `npm`:

```bash
npm install @gleanwork/mcp-server
```

With `pnpm`:

```bash
pnpm install @gleanwork/mcp-server
```

With `yarn`:

```bash
yarn add @gleanwork/mcp-server
```

## Configuration

1. Set up your Glean API credentials:

```bash
export GLEAN_SUBDOMAIN=your_subdomain
export GLEAN_API_TOKEN=your_api_token
```

1. (Optional) For global tokens that support impersonation:

```bash
export GLEAN_ACT_AS=user@example.com
```

## Tools

### glean_search

Search Glean's content index using the Glean Search API. This tool allows you to query Glean's content index with various filtering and configuration options.

For complete parameter details, see [Search API Documentation](https://developers.glean.com/client/operation/search/)

### glean_chat

Interact with Glean's AI assistant using the Glean Chat API. This tool allows you to have conversational interactions with Glean's AI, including support for message history, citations, and various configuration options.

For complete parameter details, see [Chat API Documentation](https://developers.glean.com/client/operation/chat/)

## Running the Server

The server communicates via stdio, making it ideal for integration with AI models and other tools:

```bash
node build/index.js
```

## Running in inspect mode

The server can also be run in inspect mode, which provides additional debugging information:

```bash
pnpm inspector
```

This will run MCP's inspector, which allows you to execute and debug calls to the server.

## Contributing

Please see [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

MIT License - see the [LICENSE](LICENSE) file for details

## Support

- Documentation: [docs.glean.com](https://docs.glean.com)
- Issues: [GitHub Issues](https://github.com/gleanwork/mcp-server/issues)
- Email: [support@glean.com](mailto:support@glean.com)
