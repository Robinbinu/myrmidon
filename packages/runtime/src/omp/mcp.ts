/**
 * omp's MCP client and the adapter that turns a server's tool into an agent tool. Loaded when the first server
 * connects, so a person with no MCP servers never loads them.
 */
export async function loadMcp() {
  const { MCPManager } = await import('@oh-my-pi/pi-coding-agent/mcp/manager')
  const { CustomToolAdapter } = await import('@oh-my-pi/pi-coding-agent/extensibility/custom-tools/wrapper')
  return { MCPManager, CustomToolAdapter }
}
