/**
 * The MCP server SDK's Node shims, with the SDK's own no-codegen JSON Schema validator (the one it ships for
 * Cloudflare Workers) in place of Ajv. Ajv compiles schemas into code with `new Function`, which plugin security
 * scanners flag; telepathy's schemas are tiny, so interpreting them costs nothing. Wired in by an esbuild alias.
 */
export { CfWorkerJsonSchemaValidator as DefaultJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';
export { default as process } from 'node:process';
