# Advanced MCP Configuration

The normal setup path is **Settings -> MCP**. StashBase can write the MCP
configuration for supported clients or copy a snippet for clients that manage
their own configuration.

## Manual stdio Setup

The packaged MCP command is generated at:

```text
~/.stashbase/bin/stashbase-mcp
%USERPROFILE%\.stashbase\bin\stashbase-mcp.cmd  # Windows
```

### Claude Code

```bash
claude mcp add stashbase -- ~/.stashbase/bin/stashbase-mcp
# Windows:
claude mcp add stashbase -- %USERPROFILE%\.stashbase\bin\stashbase-mcp.cmd
```

### Claude Desktop

In `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "stashbase": {
      "command": "/Users/YOUR_USER/.stashbase/bin/stashbase-mcp"
    }
  }
}
```

### Codex CLI

In `~/.codex/config.toml`:

```toml
[mcp_servers.stashbase]
command = "/Users/YOUR_USER/.stashbase/bin/stashbase-mcp"
# Windows:
command = "C:\\Users\\YOUR_USER\\.stashbase\\bin\\stashbase-mcp.cmd"
```

Restart the client after changing its MCP configuration.

## URL-based Clients

Server-side clients that cannot spawn a local process can use Streamable HTTP.
Open **Settings -> MCP -> URL access** to copy the current URL and bearer token.
Requests send:

```text
Authorization: Bearer <token shown in Settings>
```

Same-machine access uses `http://127.0.0.1:8090/mcp` and stays on loopback.

Docker access is disabled by default. Enabling it in Settings opens a separate,
token-gated, MCP-only listener at
`http://host.docker.internal:8091/mcp` by default. Disable Docker access before
choosing another port in Settings. No other StashBase API is exposed on that
port.

Docker Desktop or the host firewall must allow the selected port. Native Linux
Docker Engine also needs
`--add-host=host.docker.internal:host-gateway`, or the equivalent Compose
`extra_hosts` entry.

## Security Boundaries

The token is stored in `~/.stashbase/config.json`, shown and rotated only
through Settings, and checked on every request. Rotating it immediately
invalidates the old value.

The endpoint is stateless JSON-RPC over POST. Browser-page clients are
intentionally unsupported by the Origin and CORS boundary; URL access is for
server-side MCP clients.
