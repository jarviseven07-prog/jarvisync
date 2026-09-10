process.env.JARVISYNC_CONNECTION ??= new URL('./connection.json', import.meta.url).pathname;
await import('../../../runtime/mcp.mjs');
