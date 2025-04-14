/**
 * Configuration module for Glean MCP Server
 *
 * Handles configuration of MCP settings for different host applications:
 * - Claude Desktop
 * - Windsurf
 * - Cursor
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';
import { availableClients, ensureClientsLoaded } from './configure/index.js';
import { VERSION } from './common/version.js';

/**
 * Configure options interface
 */
interface ConfigureOptions {
  token?: string;
  domain?: string;
  envPath?: string;
}

/**
 * Load environment variables from .env file or existing environment
 */
function loadCredentials(options: ConfigureOptions): {
  subdomain?: string;
  apiToken?: string;
} {
  const result: { subdomain?: string; apiToken?: string } = {
    subdomain: undefined,
    apiToken: undefined,
  };

  if (options.envPath) {
    try {
      const envPath = options.envPath.startsWith('~')
        ? options.envPath.replace('~', os.homedir())
        : options.envPath;

      if (!fs.existsSync(envPath)) {
        console.error(`Warning: .env file not found at ${envPath}`);
      } else {
        const envConfig = dotenv.config({ path: envPath });

        if (envConfig.error) {
          throw new Error(
            `Failed to parse .env file: ${envConfig.error.message}`,
          );
        }

        result.subdomain = envConfig.parsed?.GLEAN_SUBDOMAIN;
        result.apiToken = envConfig.parsed?.GLEAN_API_TOKEN;
      }
    } catch (error: any) {
      console.error(`Error loading .env file: ${error.message}`);
    }
  }

  if (options.domain) {
    result.subdomain = options.domain;
  }

  if (options.token) {
    result.apiToken = options.token;
  }

  if (!result.subdomain) {
    result.subdomain = process.env.GLEAN_SUBDOMAIN;
  }

  if (!result.apiToken) {
    result.apiToken = process.env.GLEAN_API_TOKEN;
  }

  return result;
}

/**
 * Handles the configuration process for the specified MCP client
 *
 * @param client - The MCP client to configure for (cursor, claude, windsurf)
 * @param options - Configuration options including token, domain, and envPath
 */
export async function configure(client: string, options: ConfigureOptions) {
  await ensureClientsLoaded();

  const normalizedClient = client.toLowerCase();

  if (!availableClients[normalizedClient]) {
    console.error(`Unsupported MCP client: ${client}`);
    console.error(
      'Supported clients: ' + Object.keys(availableClients).join(', '),
    );
    process.exit(1);
  }

  const clientConfig = availableClients[normalizedClient];
  console.log(`Configuring Glean MCP for ${clientConfig.displayName}...`);

  const homedir = os.homedir();
  const configFilePath = clientConfig.configFilePath(homedir);

  try {
    const { subdomain, apiToken } = loadCredentials(options);

    const newConfig = clientConfig.configTemplate(subdomain, apiToken);

    if (fs.existsSync(configFilePath)) {
      const fileContent = fs.readFileSync(configFilePath, 'utf-8');
      let existingConfig: Record<string, any>;

      try {
        existingConfig = JSON.parse(fileContent);
      } catch (error: any) {
        console.error(
          `Error parsing existing configuration file: ${error.message}`,
        );
        console.error(
          `Creating backup of existing file and creating new one...`,
        );

        const backupPath = `${configFilePath}.backup-${Date.now()}`;
        fs.copyFileSync(configFilePath, backupPath);
        console.log(`Backup created at: ${backupPath}`);

        fs.writeFileSync(configFilePath, JSON.stringify(newConfig, null, 2));
        console.log(`New configuration file created at: ${configFilePath}`);
        console.log(clientConfig.successMessage(configFilePath));
        return;
      }

      if (
        existingConfig.mcpServers &&
        existingConfig.mcpServers.glean &&
        existingConfig.mcpServers.glean.command === 'npx' &&
        existingConfig.mcpServers.glean.args &&
        existingConfig.mcpServers.glean.args.includes('@gleanwork/mcp-server')
      ) {
        console.log(
          `Glean MCP configuration already exists in ${clientConfig.displayName}.`,
        );
        console.log(`Configuration file: ${configFilePath}`);
        return;
      }

      existingConfig.mcpServers = existingConfig.mcpServers || {};
      existingConfig.mcpServers.glean = newConfig.mcpServers.glean;

      fs.writeFileSync(configFilePath, JSON.stringify(existingConfig, null, 2));
      console.log(`Updated configuration file at: ${configFilePath}`);
    } else {
      const configDir = path.dirname(configFilePath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      fs.writeFileSync(configFilePath, JSON.stringify(newConfig, null, 2));
      console.log(`Created new configuration file at: ${configFilePath}`);
    }

    console.log(clientConfig.successMessage(configFilePath));
  } catch (error: any) {
    console.error(`Error configuring client: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Lists all supported MCP clients
 */
export async function listSupportedClients() {
  await ensureClientsLoaded();

  console.log('\nSupported MCP clients:');
  console.log('=====================');

  const clients = Object.entries(availableClients);

  if (clients.length === 0) {
    console.log(
      'No clients found. This may be an issue with the configuration.',
    );
  } else {
    const longestName = Math.max(...clients.map(([key]) => key.length));

    for (const [key, config] of clients) {
      console.log(`  ${key.padEnd(longestName + 2)} ${config.displayName}`);
    }
  }

  console.log('\nUsage:');
  console.log(
    '  npx @gleanwork/mcp-server configure --client <client> [--token <token>] [--domain <domain>]',
  );
  console.log(
    '  npx @gleanwork/mcp-server configure --client <client> --env <path-to-env-file>',
  );

  console.log('\nExamples:');
  if (clients.length > 0) {
    const exampleClient = clients[0][0];
    console.log(
      `  npx @gleanwork/mcp-server configure --client ${exampleClient} --token your-token --domain your-domain`,
    );
    console.log(
      `  npx @gleanwork/mcp-server configure --client ${exampleClient} --env ~/.glean.env`,
    );
  }

  console.log(`\nVersion: v${VERSION}`);
}
