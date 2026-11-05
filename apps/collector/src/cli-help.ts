const commands = {
  start: ['Start the collector in this terminal (default command).', 'agent-deck start', 'Keep the terminal open; press Ctrl+C to stop. First run asks which providers to enable.'],
  status: ['Check whether the collector is reachable.', 'agent-deck status', 'Exits 0 when online, 1 when offline.'],
  doctor: ['Inspect local setup, provider capabilities, and collector health.', 'agent-deck doctor [--json]', '--json prints a structured report for scripts. Works without provider setup.\nChecks local detection, not active collector connections. Optional providers may be unavailable.'],
  setup: ['Choose providers or repair integrations.', 'agent-deck setup\nagent-deck setup providers <opencode,claude,codex,agy|none>\nagent-deck setup <claude|agy> [--dry-run]\nagent-deck setup tailscale', 'Run setup for an interactive provider picker. Restart the collector after changes.\n--dry-run previews hook changes. tailscale configures private HTTPS access.'],
  pair: ['Connect a tablet over your private LAN.', 'agent-deck pair [--host <private-IPv4> | --local]', 'Starts the collector if stopped and prints a QR code. Keep that terminal open.\n--host selects the PC address. --local creates only a local browser pairing code.\nCodes expire after five minutes. PC and tablet must share a reachable network.'],
  probe: ['Inspect recent events from one enabled provider.', 'agent-deck probe [--source <opencode|claude|codex|agy|pty>] [--tail <count>]', 'Defaults: source opencode, tail 20. Useful when sessions are missing.'],
  devices: ['List or revoke paired devices.', 'agent-deck devices [list]\nagent-deck devices revoke <device-id>\nagent-deck devices revoke-all', 'Use list to find device IDs. revoke-all also invalidates outstanding pairing codes.'],
  uninstall: ['Remove Agent Deck observer hooks.', 'agent-deck uninstall [claude|agy]', 'Defaults to claude. Removes hooks, not the application or stored history.'],
  run: ['Observe a CLI through the PTY fallback.', 'agent-deck run -- <cli> [args...]', 'Example: agent-deck run -- claude\nArguments after -- are passed to the wrapped CLI.'],
  import: ['Backfill history from enabled providers.', 'agent-deck import', 'Imports local history and refreshes the model catalog.'],
  mcp: ['Start the MCP server over standard input/output.', 'agent-deck mcp', 'Use this command in your MCP client configuration.']
} satisfies Record<string, [string, string, string]>;

export function formatHelp(command?: string): string | undefined {
  if (command) {
    const entry = commands[command as keyof typeof commands];
    if (!entry) return undefined;
    return `Agent Deck / ${command}\n\n${entry[0]}\n\nUsage\n  ${entry[1].replaceAll('\n', '\n  ')}\n\n${entry[2]}\n\nMore: agent-deck help`;
  }
  return `Agent Deck — observe your coding agents in one place

Usage: agent-deck <command> [options]

Get started
  agent-deck setup           Choose the providers you want to monitor
  agent-deck start           Start locally; keep this terminal open
  agent-deck pair            Open on a tablet with a QR code

Commands
${Object.entries(commands).map(([name, entry]) => `  ${name.padEnd(12)}${entry[0]}`).join('\n')}

Help
  agent-deck help <command>  Details, options, and examples
  agent-deck <command> -h    Command help (also --help)
  agent-deck --version       Print version (also -v)

Troubleshooting
  agent-deck doctor          Check setup and see next steps
  agent-deck probe --source codex --tail 10

Environment
  AGENT_DECK_PORT            Collector port (default 4100)
  AGENT_DECK_DB_PATH         Database file (default ~/.agent-deck/collector.db)
  AGENT_DECK_LAN_HOST        PC private IPv4 for LAN access
  AGENT_DECK_IMPORT_HISTORY  Set to 0 to skip startup history import

From source
  npm run agent-deck doctor
  npm run agent-deck -- pair --host 192.168.1.20
  Commands need no separator; use -- before commands with flags.

Help and doctor are always available without setup.`;
}
