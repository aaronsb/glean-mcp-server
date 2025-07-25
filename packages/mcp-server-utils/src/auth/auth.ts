import readline from 'node:readline';

import open from 'open';
import {
  getServerUrlHash,
  writeJsonFile as writeMcpRemoteJSONFile,
} from '@gleanwork/connect-mcp-server/lib';

import {
  getConfig,
  GleanConfig,
  GleanOAuthConfig,
  GleanTokenConfig,
  isBasicConfig,
  isGleanTokenConfig,
  isOAuthConfig,
} from '../config/index.js';
import { debug, error, trace } from '../log/logger.js';
import { loadTokens, saveTokens, Tokens } from './token-store.js';
import {
  AuthResponse,
  isAuthResponse,
  isAuthResponseWithURL,
  isTokenSuccess,
  TokenError,
  TokenResponse,
} from './types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import { loadOAuthMetadata, saveOAuthMetadata } from './oauth-cache.js';
import { AuthError } from './error.js';
import { AuthErrorCode } from './error.js';
import { parse as parseDomain } from 'tldts';

/**
 * Validate that the configuration can plausibly access the resource.  This
 * means that either a Glean token was provided, or we have enough information
 * to attempt an OAuth flow.
 *
 * If there's no token, OAuth discovery will occur (i.e. requests to OAuth
 * protected resource metadata and OAuth authorization server metadata).
 *
 * If OAuth is configured but no token is present, then the user will be asked
 * to authenticate via the device authorization flow.
 *
 * If OAuth is configured and tokens are already saved, no authorization flow
 * will be attempted.
 *
 * If an authorization token is expired and a refresh token is available,
 * automatic refresh will be attempted.
 *
 * If this returns true, that means we have an access token, but it doesn't
 * guarantee that the token will validate -- it isn't tested
 *
 * This doesn't guarantee that the token will be accepted -- it isn't tested
 * for things like revocation or server rejection due to unaccepted client,
 * OAuth disabled &c..
 */
export async function ensureAuthTokenPresence() {
  trace('validateAccessTokenOrAuth');

  const config = await getConfig();
  if (isGleanTokenConfig(config)) {
    return true;
  }

  let tokens = loadTokens();
  if (tokens === null) {
    tokens = await forceAuthorize();
  }

  if (tokens && tokens.isExpired()) {
    debug('Access token expired, attempting refresh');
    await forceRefreshTokens();
    tokens = loadTokens();
  }

  return tokens !== null;
}

interface SetupMcpRemoteOptions {
  target: 'agents' | 'default';
}

/**
 * Set up mcp-remote.  Copies auth tokens and device flow client information to
 * locations where mcp-remote will read them from.
 *
 * This function must only be called **after** a successful authentication
 * (via, e.g. ensureAuthTokenPresence).
 *
 * Token expiration is set to 1 second to force mcp-remote to fetch a new
 * access token with the refresh token.  Thereafter mcp-remote is taking over
 * the refresh duties until the refresh token expires, at which point users
 * must re-run the configuration.
 */
export async function setupMcpRemote(opts: SetupMcpRemoteOptions) {
  const config = await getConfig();
  if (isGleanTokenConfig(config)) {
    throw new AuthError(
      'Cannot setup MCP remote with Glean token configuration. Please use OAuth configuration instead.',
      { code: AuthErrorCode.GleanTokenConfigUsedForOAuth },
    );
  }

  const origin = new URL(config.baseUrl).origin;
  const serverUrl =
    opts.target === 'agents'
      ? `${origin}/mcp/agents/sse`
      : `${origin}/mcp/default/sse`;

  const serverHash = getServerUrlHash(serverUrl);

  trace(`setting up mcp-auth for server: ${serverUrl} hash: ${serverHash}`);

  const clientData = loadOAuthMetadata();
  if (clientData === null) {
    throw new AuthError(
      'Missing OAuth metadata required for MCP remote setup. Please authenticate first using OAuth.',
      { code: AuthErrorCode.MissingOAuthMetadata },
    );
  }
  const tokens = loadTokens();
  if (tokens == null) {
    throw new AuthError(
      'Missing OAuth tokens required for MCP remote setup. Please authenticate first using OAuth.',
      { code: AuthErrorCode.MissingOAuthTokens },
    );
  }

  const mcpRemoteClientInfo: OAuthClientInformationFull = {
    client_id: clientData.clientId,
    // This is included just to pass runtime type checks in mcp-remote.  It
    // isn't used because we won't have native auth configured and won't go
    // through the auth grant flow.  But we still need to read the file to get
    // the tokens and have mcp-remote go through the refresh flow.
    redirect_uris: ['http://localhost:9999/cb'],
  };
  if (clientData?.clientSecret) {
    mcpRemoteClientInfo.client_secret = clientData?.clientSecret;
  }
  await writeMcpRemoteJSONFile(
    serverHash,
    'client_info.json',
    mcpRemoteClientInfo,
  );

  const mcpRemoteTokens: OAuthTokens = {
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_type: 'Bearer',
    // set short expiration for the access token mcp-remote will fetch a new
    // one via the refresh token and then be responsible for continuously
    // refreshing
    expires_in: 1,
  };
  await writeMcpRemoteJSONFile(serverHash, 'tokens.json', mcpRemoteTokens);
}

/**
 * Go through the device authorization flow.  It's an error to call this with a
 * Glean token config.  With a basic config, will attempt auth discovery (see
 * `discoverOAuthConfig`).
 *
 * Tokens obtained via authorization will be saved with the token store.
 *
 * Returns the tokens obtained from the authorization flow or `null` if no
 * tokens were obtained (e.g. if the user did not authenticate or did not enter
 * the user code).
 */
export async function forceAuthorize(config?: GleanConfig) {
  if (config === undefined || isBasicConfig(config)) {
    config = await getConfig({ discoverOAuth: true });
  }

  if (isGleanTokenConfig(config)) {
    throw new AuthError(
      `Cannot get OAuth access token when using glean-token configuration.  Specify GLEAN_OAUTH_ISSUER and GLEAN_OAUTH_CLIENT_ID and not GLEAN_API_TOKEN to use OAuth.`,
      { code: AuthErrorCode.GleanTokenConfigUsedForOAuth },
    );
  }
  const tokens = await authorize(config);
  if (tokens !== null) {
    saveTokens(tokens);
  }

  return tokens;
}

export async function attemptUpgradeConfigToOAuth(
  config: GleanConfig,
): Promise<GleanTokenConfig | GleanOAuthConfig> {
  if (isGleanTokenConfig(config)) {
    return config;
  }

  const oauthConfig = await discoverOAuthConfig(config);

  if ('clientSecret' in oauthConfig && oauthConfig.clientSecret === undefined) {
    delete oauthConfig['clientSecret'];
  }
  saveOAuthMetadata(oauthConfig);

  return oauthConfig;
}

/**
 * From a basic config, return a `GleanOAuthConfig` if possible.
 *
 * This entails first fetching the OAuth protected resource metadata to obtain:
 *  1. The issuer and
 *  2. The device flow clientId
 *
 * And then fetching the authorization server metadata to obtain:
 *  1. The device authorization endpoint and
 *  2. The token endpoint
 *
 * @returns a complete GleanOAuth config necessary to perform the device
 * authorization flow.
 *
 */
export async function discoverOAuthConfig(
  config?: GleanConfig,
): Promise<GleanOAuthConfig> {
  debug('discovering OAuth config');

  if (config === undefined) {
    config = await getConfig();
  }

  if (isGleanTokenConfig(config)) {
    throw new AuthError(
      '[internal error] attempting OAuth flow with a Glean-issued non-OAuth token',
      { code: AuthErrorCode.InvalidConfig },
    );
  } else if (isOAuthConfig(config)) {
    return config;
  }

  let { issuer, clientId, clientSecret } = config;
  if (typeof issuer !== 'string' || typeof clientId !== 'string') {
    trace('request protected resource metadata');
    const resourceMetadata = await fetchProtectedResourceMetadata(config);
    issuer = resourceMetadata.issuer;
    clientId = resourceMetadata.clientId;
    clientSecret = resourceMetadata?.clientSecret;
  } else {
    trace('using environment variables for issuer and client id');
  }

  const { deviceAuthorizationEndpoint, tokenEndpoint } =
    await fetchAuthorizationServerMetadata(issuer);

  const oauthConfig: GleanOAuthConfig = {
    baseUrl: config.baseUrl,
    issuer,
    clientId,
    clientSecret,
    authorizationEndpoint: deviceAuthorizationEndpoint,
    tokenEndpoint,
    authType: 'oauth',
  };

  debug('OAuth config', oauthConfig);

  return oauthConfig;
}

function failAuthorizationServerMetadataFetch(cause: any): never {
  throw new AuthError(
    'Unable to fetch OAuth authorization server metadata: please contact your Glean administrator and ensure device flow authorization is configured correctly.',
    { code: AuthErrorCode.AuthServerMetadataNetwork, cause },
  );
}

async function fetchOpenIdConfiguration(issuer: string): Promise<Response> {
  const url = `${issuer}/.well-known/openid-configuration`;
  let response;
  try {
    response = await fetch(url);
    trace('GET', url, response.status);
  } catch (cause: any) {
    error(cause);
    failAuthorizationServerMetadataFetch(cause);
  }
  if (!response.ok) {
    failAuthorizationServerMetadataFetch(undefined);
  }
  return response;
}

async function fetchOauthAuthorizationServerConfig(
  issuer: string,
): Promise<Response> {
  const url = `${issuer}/.well-known/oauth-authorization-server`;
  let response;
  try {
    response = await fetch(url);
    trace('GET', url, response.status);
  } catch (cause: any) {
    error(cause);
    failAuthorizationServerMetadataFetch(cause);
  }
  if (!response.ok) {
    failAuthorizationServerMetadataFetch(undefined);
  }
  return response;
}

export async function fetchAuthorizationServerMetadata(
  issuer: string,
): Promise<{ deviceAuthorizationEndpoint: string; tokenEndpoint: string }> {
  let response;
  try {
    response = await fetchOpenIdConfiguration(issuer);
  } catch (cause: any) {
    trace(
      'Falling back to',
      `${issuer}/.well-known/oauth-authorization-server`,
      cause,
    );
    response = await fetchOauthAuthorizationServerConfig(issuer);
  }

  let responseJson;
  try {
    responseJson = (await response.json()) as Record<string, any>;
    trace(responseJson);
  } catch (cause: any) {
    throw new AuthError(
      'Unable to fetch OAuth authorization server metadata: please contact your Glean administrator and ensure device flow authorization is configured correctly.',
      { code: AuthErrorCode.AuthServerMetadataParse, cause },
    );
  }

  const deviceAuthorizationEndpoint =
    responseJson['device_authorization_endpoint'];
  const tokenEndpoint = responseJson['token_endpoint'];

  if (typeof tokenEndpoint !== 'string') {
    throw new AuthError(
      'OAuth authorization server metadata did not include a token endpoint: please contact your Glean administrator and ensure device flow authorization is configured correctly.',
      { code: AuthErrorCode.AuthServerMetadataMissingTokenEndpoint },
    );
  }

  if (typeof deviceAuthorizationEndpoint !== 'string') {
    throw new AuthError(
      'OAuth authorization server metadata did not include a device authorization endpoint: please contact your Glean administrator and ensure device flow authorization is configured correctly.',
      { code: AuthErrorCode.AuthServerMetadataMissingDeviceEndpoint },
    );
  }

  return {
    deviceAuthorizationEndpoint,
    tokenEndpoint,
  };
}

interface ProtectedResourceMetadata {
  issuer: string;
  clientId: string;
  clientSecret?: string;
}
export async function fetchProtectedResourceMetadata(
  config: GleanConfig,
): Promise<ProtectedResourceMetadata> {
  const origin = new URL(config.baseUrl).origin;
  const protectedResourceUrl = `${origin}/.well-known/oauth-protected-resource`;

  let response;
  try {
    response = await fetch(protectedResourceUrl);
    trace('GET', protectedResourceUrl, response.status);
  } catch (cause: any) {
    error(cause);
    throw new AuthError(
      'Unable to fetch OAuth protected resource metadata: please contact your Glean administrator and ensure device flow authorization is configured correctly.',
      { code: AuthErrorCode.ProtectedResourceMetadataNetwork, cause },
    );
  }

  if (!response.ok) {
    throw new AuthError(
      'Unable to fetch OAuth protected resource metadata: please contact your Glean administrator and ensure device flow authorization is configured correctly.',
      { code: AuthErrorCode.ProtectedResourceMetadataNotOk },
    );
  }

  let responseJson;
  try {
    responseJson = (await response.json()) as Record<string, any>;
    trace(JSON.stringify(responseJson, null, 2));
  } catch (cause: any) {
    throw new AuthError(
      'Unexpected OAuth protected resource metadata: please contact your Glean administrator and ensure device flow authorization is configured correctly.',
      { code: AuthErrorCode.ProtectedResourceMetadataParse, cause },
    );
  }

  const authServers = responseJson['authorization_servers'];
  const clientId = responseJson['glean_device_flow_client_id'];
  const clientSecret = responseJson['glean_device_flow_client_sec'];

  let issuer;
  if (Array.isArray(authServers) && authServers.length > 0) {
    issuer = authServers[0];
  }

  if (typeof issuer !== 'string') {
    throw new AuthError(
      'OAuth protected resource metadata did not include any authorization servers: please contact your Glean administrator and ensure device flow authorization is configured correctly.',
      { code: AuthErrorCode.ProtectedResourceMetadataMissingAuthServers },
    );
  }
  if (typeof clientId !== 'string') {
    throw new AuthError(
      'OAuth protected resource metadata did not include a device flow client id: please contact your Glean administrator and ensure device flow authorization is configured correctly.',
      { code: AuthErrorCode.ProtectedResourceMetadataMissingClientId },
    );
  }

  const result: ProtectedResourceMetadata = {
    issuer,
    clientId,
  };

  if (clientSecret !== undefined) {
    result.clientSecret = clientSecret;
  }

  return result;
}

export async function forceRefreshTokens() {
  trace('forceRefreshTokens');

  const config = await getConfig({ discoverOAuth: true });

  if (isGleanTokenConfig(config)) {
    throw new AuthError(
      `Cannot refresh OAuth access token when using glean-token configuration.  Specify GLEAN_OAUTH_ISSUER and GLEAN_OAUTH_CLIENT_ID and not GLEAN_API_TOKEN to use OAuth.`,
      { code: AuthErrorCode.GleanTokenConfigUsedForOAuthRefresh },
    );
  }

  let tokens = loadTokens();
  if (tokens === null) {
    throw new AuthError(`Cannot refresh: unable to locate refresh token.`, {
      code: AuthErrorCode.RefreshTokenNotFound,
    });
  }

  tokens = await fetchTokenViaRefresh(tokens, config);
  saveTokens(tokens);
}

/**
 * see <https://datatracker.ietf.org/doc/html/rfc6749#section-6>
 */
async function fetchTokenViaRefresh(tokens: Tokens, config: GleanOAuthConfig) {
  const { refreshToken } = tokens;
  if (refreshToken === undefined) {
    throw new AuthError(`Cannot refresh: no refresh token provided.`, {
      code: AuthErrorCode.RefreshTokenMissing,
    });
  }

  trace('Starting refresh flow');

  // see <https://datatracker.ietf.org/doc/html/rfc6749#section-6>
  const url = config.tokenEndpoint;
  const params = new URLSearchParams();
  params.set('client_id', config.clientId);
  if (typeof config.clientSecret === 'string') {
    // These "secrets" are obviously not secure since public OAuth clients by
    // definition cannot keep secrets.
    //
    // However, some OAuth providers insist on generating and requiring client
    // secrets even for public OAuth clients.
    params.set('client_secret', config.clientSecret);
  }
  params.set('grant_type', 'refresh_token');
  params.set('refresh_token', refreshToken);

  const options: RequestInit = {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  };
  trace(options.method ?? 'GET', url, options);

  let response, responseRaw;
  try {
    responseRaw = await fetch(url, options);
    trace(responseRaw.status, responseRaw.statusText);
    response = await responseRaw.json();
  } catch (cause: any) {
    throw new AuthError('Unexpected response fetching access token.', {
      code: AuthErrorCode.UnexpectedAccessTokenResponse,
      cause,
    });
  }

  if (isTokenSuccess(response)) {
    // Uncomment for testing.  This will write tokens to the log.
    trace('/token', response);
    return Tokens.buildFromTokenResponse(response);
  } else {
    const errorResponse = response as TokenError;
    trace('/token', errorResponse?.error);
    throw new AuthError(
      `Unable to fetch token.  Server responded ${responseRaw.status}: ${errorResponse?.error}`,
      { code: AuthErrorCode.FetchTokenServerError, cause: errorResponse },
    );
  }
}

async function authorize(config: GleanOAuthConfig): Promise<Tokens | null> {
  trace('Starting OAuth authorization flow');

  if (!process.stdin.isTTY) {
    throw new AuthError(
      'OAuth device authorization flow requires an interactive terminal.',
      { code: AuthErrorCode.NoInteractiveTerminal },
    );
  }

  const abortController = new AbortController();
  let cause: any = undefined;
  try {
    const authResponse = await fetchDeviceAuthorization(config);
    const tokenPoller = pollForToken(authResponse, config).catch((e) => {
      cause = e;
    });
    // Don't wait for this; if the user copies the URL manually and enters the code that's fine.
    promptUserAndOpenVerificationPage(
      authResponse,
      abortController.signal,
    ).catch((e) => {
      error('prompting user for verification page', e);
    });
    const tokenResponse = await tokenPoller;

    // Clean up the readline interface now that we have the token
    abortController.abort();

    if (cause !== undefined) {
      throw cause;
    }
    return Tokens.buildFromTokenResponse(tokenResponse as TokenResponse);
  } catch (cause: any) {
    // Clean up the readline interface on error as well
    abortController.abort();

    if (cause instanceof AuthError) {
      throw cause;
    }
    throw new Error('Unexpected error obtaining authorization token', {
      cause,
    });
  }
}

async function waitForUserEnter(signal?: AbortSignal) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      rl.close();
    };

    rl.once('line', () => {
      cleanup();
      resolve();
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        cleanup();
        resolve(); // Resolve silently when aborted
      });
    }
  });
}

async function promptUserAndOpenVerificationPage(
  authResponse: AuthResponse,
  signal?: AbortSignal,
) {
  console.log(`
Authorizing Glean MCP-server.  Please log in to Glean.

! First copy your one-time code: ${authResponse.user_code}

Press Enter to open the following URL where the code is needed:

${authResponse.verification_uri}
`);

  await waitForUserEnter(signal);

  // signal is aborted if the user manually opened the URL and entered the
  // code, in which case we shouldn't then open the URL again ourselves.
  if (signal?.aborted) {
    return;
  }

  await open(authResponse.verification_uri);
}

async function pollForToken(
  authResponse: AuthResponse,
  config: GleanOAuthConfig,
): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const timeoutMs = 10 * 60 * 1000; // 10 minutes
    const startTime = Date.now();

    const poll = async () => {
      const now = Date.now();
      if (now - startTime >= timeoutMs) {
        reject(
          new AuthError(
            'OAuth device flow timed out after 10 minutes. Please try again.',
            { code: AuthErrorCode.OAuthPollingTimeout },
          ),
        );
        return;
      }
      // e.g. https://authorization-server/token
      const url = config.tokenEndpoint;
      const params = new URLSearchParams();
      params.set('client_id', config.clientId);
      if (typeof config.clientSecret === 'string') {
        // These "secrets" are obviously not secure since public OAuth clients by
        // definition cannot keep secrets.
        //
        // However, some OAuth providers insist on generating and requiring client
        // secrets even for public OAuth clients.
        params.set('client_secret', config.clientSecret);
      }
      params.set('grant_type', 'urn:ietf:params:oauth:grant-type:device_code');
      params.set('device_code', authResponse.device_code);

      const options: RequestInit = {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params,
      };
      trace(options.method ?? 'GET', url, options);
      const responseRaw = await fetch(url, options);
      trace(responseRaw.status, responseRaw.statusText);
      const response = await responseRaw.json();

      if (isTokenSuccess(response)) {
        trace('/token', response);
        resolve(response);
      } else {
        const errorResponse = response as TokenError;
        trace('/token', errorResponse?.error);
        if (errorResponse.error == 'authorization_pending') {
          setTimeout(poll, authResponse.interval * 1_000);
        } else {
          reject(
            new AuthError('Unexpected error requesting authorization grant', {
              code: AuthErrorCode.UnexpectedAuthGrantError,
              cause: errorResponse,
            }),
          );
        }
      }
    };

    poll().catch(reject);
  });
}

/**
 * Returns the OAuth scopes we need for the issuer.
 *
 * In general this is "openid profile offline_access", but some providers may
 * require different scopes for idiosyncratic reasons.
 *
 * We require two things that are driven by scopes:
 *
 *  - user email (openid profile)
 *  - refresh tokens (offline_access)
 */
export function getOAuthScopes(config: GleanOAuthConfig): string {
  const { issuer: issuer } = config;
  const domain = parseDomain(issuer).domain ?? '';

  trace(`computing scopes for issuer: '${issuer}', instance: '${domain}'`);

  switch (domain) {
    case 'google.com':
      return 'openid profile https://www.googleapis.com/auth/userinfo.email';
    case 'okta.com':
      return 'openid profile offline_access';
    default:
      return 'openid profile offline_access';
  }
}

export async function fetchDeviceAuthorization(
  config: GleanOAuthConfig,
): Promise<AuthResponse> {
  const params = new URLSearchParams();
  params.set('client_id', config.clientId);
  params.set('scope', getOAuthScopes(config));

  // e.g. https://some-authorization-server/authorize
  const url = config.authorizationEndpoint;
  const options: RequestInit = {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  };

  trace(
    options.method ?? 'GET',
    url,
    options.headers,
    Object.fromEntries(params.entries()),
  );

  const response = await fetch(url, options);
  const responseJson = await response.json();

  if (
    !(
      response.ok &&
      responseJson !== undefined &&
      typeof responseJson === 'object'
    )
  ) {
    throw new AuthError('Error obtaining auth grant', {
      code: AuthErrorCode.UnexpectedAuthGrantError,
      cause: new Error(
        JSON.stringify({ status: response.status, body: responseJson }),
      ),
    });
  }

  const result = { ...responseJson } as any;

  if (isAuthResponseWithURL(responseJson)) {
    result['verification_uri'] = result['verification_url'];
    delete result['verification_url'];
  } else if (!isAuthResponse(responseJson)) {
    throw new AuthError('Unexpected auth grant response', {
      code: AuthErrorCode.UnexpectedAuthGrantResponse,
      cause: new Error(JSON.stringify(responseJson)),
    });
  }

  return result;
}
