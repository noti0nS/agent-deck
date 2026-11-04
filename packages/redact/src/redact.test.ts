import { describe, expect, it } from 'vitest';
import { Redactor } from './index.js';

describe('packages/redact Redactor', () => {
  const redactor = new Redactor();

  it('redacts sk-..., ghp_..., AKIA..., and Bearer tokens', () => {
    const raw =
      'Keys: sk-proj-1234567890abcdefghij, ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456, AKIAIOSFODNN7EXAMPLE, Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    const cleaned = redactor.redactString(raw);
    expect(cleaned).not.toContain('sk-proj-1234567890abcdefghij');
    expect(cleaned).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456');
    expect(cleaned).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(cleaned).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(cleaned).toContain('[REDACTED:SK_KEY]');
    expect(cleaned).toContain('[REDACTED:GH_TOKEN]');
    expect(cleaned).toContain('[REDACTED:AWS_KEY]');
    expect(cleaned).toContain('Bearer [REDACTED:BEARER]');
  });

  it('redacts password= and token= assignments', () => {
    const raw = 'curl --url https://example.com?token=my_super_secret_123 -d "password=hunter2_secret"';
    const cleaned = redactor.redactString(raw);
    expect(cleaned).not.toContain('my_super_secret_123');
    expect(cleaned).not.toContain('hunter2_secret');
    expect(cleaned).toContain('token=[REDACTED]');
    expect(cleaned).toContain('password=[REDACTED]');
  });

  it('redacts absolute paths under ~/.ssh, .aws, and .codex/auth.json on Windows and Unix', () => {
    const raw =
      'Reading C:\\Users\\developer\\.ssh\\id_ed25519 and /home/dev/.aws/credentials and ~/.codex/auth.json';
    const cleaned = redactor.redactString(raw);
    expect(cleaned).not.toContain('id_ed25519');
    expect(cleaned).not.toContain('.aws/credentials');
    expect(cleaned).toContain('[REDACTED:CREDENTIAL_PATH/.ssh]');
    expect(cleaned).toContain('[REDACTED:CREDENTIAL_PATH/.aws]');
    expect(cleaned).toContain('[REDACTED:CREDENTIAL_PATH/.codex/auth.json]');
  });

  it('redacts .env bodies completely while preserving .env.example', () => {
    expect(redactor.redactFileContent('/project/.env', 'OPENAI_API_KEY=xyz\nPORT=3000')).toBe(
      '[REDACTED:.ENV_BODY]'
    );
    expect(redactor.redactFileContent('C:\\app\\.env.local', 'SECRET=abc')).toBe(
      '[REDACTED:.ENV_BODY]'
    );
    expect(redactor.isDotEnvPath('/project/.env.example')).toBe(false);
  });

  it('redacts nested objects and .env diff payloads recursively', () => {
    const obj = {
      tool: 'read',
      path: 'P:\\projects\\app\\.env',
      content: 'DB_PASS=secret123',
      nested: {
        token: 'raw-token-value',
        note: 'Using sk-ant-api03-abcdefghijk123456789'
      }
    };
    const cleaned = redactor.redactValue(obj);
    expect(cleaned.content).toBe('[REDACTED:.ENV_BODY]');
    expect(cleaned.nested.token).toBe('[REDACTED]');
    expect(cleaned.nested.note).toContain('[REDACTED:SK_KEY]');
  });
});
