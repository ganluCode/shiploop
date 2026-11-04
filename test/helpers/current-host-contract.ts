export const currentHostDependencies = {
  '@earendil-works/chord': '1.5.0',
  '@earendil-works/pi-agent-core': '1.5.0',
  '@earendil-works/pi-ai': '1.5.0',
  '@earendil-works/pi-codemode': '1.5.0',
  '@earendil-works/pi-coding-agent': '1.5.0',
  '@earendil-works/pi-mcp': '1.5.0',
  '@earendil-works/pi-tui': '1.5.0',
  'shiploop-core': '0.0.0',
};

export const piSdkRuntimeFiles = new Set([
  'pi-adapter.ts', 'pi-authentication.ts', 'pi-inference-preflight.ts',
  'pi-native-session.ts', 'pi-request-retry.ts', 'mcp-stdio.ts', 'mcp-tool-catalog.ts',
]);
