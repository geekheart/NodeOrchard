"""Disposable real MCP transport fixture; launched only by the opt-in smoke."""
import os
try:
    from mcp.server.mcpserver import MCPServer
except ImportError:
    from mcp.server.fastmcp import FastMCP as MCPServer
from mcp.types import ToolAnnotations

server = MCPServer('nodeorchard-local-smoke')

@server.tool(annotations=ToolAnnotations(readOnlyHint=True))
def identity(marker: str) -> dict:
    return {'marker': marker, 'transport': 'native-mcp', 'pid': os.getpid()}

@server.tool(annotations=ToolAnnotations(readOnlyHint=False))
def echo_mutation(value: str) -> str:
    return value

if __name__ == '__main__':
    server.run(transport=os.environ.get('LOCAL_MCP_SMOKE_TRANSPORT', 'stdio'), **({'host': '127.0.0.1', 'port': int(os.environ['LOCAL_MCP_SMOKE_PORT'])} if os.environ.get('LOCAL_MCP_SMOKE_TRANSPORT') == 'streamable-http' else {}))
