import { describe, expect, it, vi } from 'vitest';
import { runCli } from './cli.js';

describe('CLI help routing', () => {
  it.each([['help', 'pair'], ['pair', '--help'], ['pair', '-h']])('shows targeted help for %j without setup', async (...args) => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await runCli(args)).toBe(0);
      expect(output).toHaveBeenCalledWith(expect.stringContaining('agent-deck pair [--host'));
      expect(output).not.toHaveBeenCalledWith(expect.stringContaining('Choose the providers'));
    } finally { output.mockRestore(); }
  });

  it('rejects an unknown help topic', async () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await runCli(['help', 'missing'])).toBe(1);
      expect(output).toHaveBeenCalledWith(expect.stringContaining('Unknown help topic: missing'));
    } finally { output.mockRestore(); }
  });
});
