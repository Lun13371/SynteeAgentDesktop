export const DEFAULT_MCP_TOOL_TIMEOUT_SECONDS = 180
export const MAX_MCP_TOOL_TIMEOUT_SECONDS = 7_200

export function isMcpToolTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= 1 && value <= MAX_MCP_TOOL_TIMEOUT_SECONDS
}
