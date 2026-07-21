# Principles

These are stable StashBase design principles for reviewing whether a product or technical decision fits the long-term direction.

- **Agent-native**: StashBase exists to make local files stable context that agents can read, search, and reuse.
- **File-first**: Local files are the source of truth. Extracted content, indexes, previews, and product state should be derived from files.
- **Local-first**: The core workflow should run on the user's own computer. Cloud capabilities can supplement the product, but should not be required for the basic path.
- **Bring your own agent**: StashBase provides context infrastructure. The same local context should be usable by different agents through MCP.
- **Small surface**: The product surface should stay focused around convert, index, search, and read. New features must serve the goal of making local files agent-readable and searchable.
- **User-controlled access**: Users decide which local folders agents can use. Agent capabilities should stay bounded by folders the user has explicitly opened or authorized.
