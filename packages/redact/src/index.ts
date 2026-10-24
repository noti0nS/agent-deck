export interface RedactorConfig {
  customPatterns?: Array<{ name: string; pattern: RegExp; replacement?: string }>;
  sensitiveDirs?: string[];
}

const DEFAULT_SENSITIVE_DIRS = [
  '.ssh',
  '.aws',
  '.codex/auth.json',
  '.codex\\auth.json',
  '.claude/.credentials.json',
  '.claude\\.credentials.json',
  '.config/gcloud',
  '.config\\gcloud',
  '.kube/config',
  '.kube\\config'
];

export class Redactor {
  private readonly rules: Array<{ name: string; pattern: RegExp; replacement: string }>;
  private readonly sensitiveDirs: string[];

  constructor(config?: RedactorConfig) {
    this.sensitiveDirs = config?.sensitiveDirs ?? DEFAULT_SENSITIVE_DIRS;
    this.rules = [
      // OpenAI / Anthropic / generic sk- keys
      {
        name: 'sk_key',
        pattern: /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{12,}\b/g,
        replacement: '[REDACTED:SK_KEY]'
      },
      // GitHub personal/fine-grained tokens
      {
        name: 'github_token',
        pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
        replacement: '[REDACTED:GH_TOKEN]'
      },
      {
        name: 'github_pat',
        pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
        replacement: '[REDACTED:GH_PAT]'
      },
      // AWS Access Key IDs
      {
        name: 'aws_akia',
        pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
        replacement: '[REDACTED:AWS_KEY]'
      },
      // Bearer tokens
      {
        name: 'bearer_token',
        pattern: /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
        replacement: '$1[REDACTED:BEARER]'
      },
      // password= / token= / api_key= / secret= assignments in URLs, CLI args, or JSON-ish text
      {
        name: 'kv_secret',
        pattern: /\b(password|passwd|token|api_key|apikey|secret|client_secret|access_token|refresh_token)(\s*[:=]\s*["']?)([^\s"',;}{]+)(["']?)/gi,
        replacement: '$1$2[REDACTED]$4'
      },
      // .env multiline key=value blocks when sensitive keys appear
      {
        name: 'dotenv_line',
        pattern: /^(\s*[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL|DATABASE_URL)[A-Z0-9_]*\s*=\s*)(.+)$/gm,
        replacement: '$1[REDACTED:ENV]'
      },
      // PEM private keys
      {
        name: 'private_key_block',
        pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
        replacement: '[REDACTED:PRIVATE_KEY]'
      }
    ];

    if (config?.customPatterns) {
      for (const cp of config.customPatterns) {
        this.rules.push({
          name: cp.name,
          pattern: cp.pattern,
          replacement: cp.replacement ?? `[REDACTED:${cp.name.toUpperCase()}]`
        });
      }
    }
  }

  public redactString(input: string): string {
    if (!input || typeof input !== 'string') return input;

    let out = input;

    // Strip sensitive credential file paths first
    out = this.redactCredentialPaths(out);

    for (const rule of this.rules) {
      out = out.replace(rule.pattern, rule.replacement);
    }

    return out;
  }

  public isDotEnvPath(filePath: string): boolean {
    if (!filePath) return false;
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    const base = normalized.split('/').pop() ?? '';
    return base === '.env' || (base.startsWith('.env.') && !base.endsWith('.example') && !base.endsWith('.sample'));
  }

  public redactFileContent(filePath: string, content: string): string {
    if (this.isDotEnvPath(filePath)) {
      return '[REDACTED:.ENV_BODY]';
    }
    return this.redactString(content);
  }

  public redactValue<T>(value: T): T {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
      return this.redactString(value) as unknown as T;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.redactValue(item)) as unknown as T;
    }
    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      const filePathHint = typeof obj.path === 'string' ? obj.path : typeof obj.file === 'string' ? obj.file : '';
      for (const [k, v] of Object.entries(obj)) {
        if (/^(password|passwd|token|apiKey|api_key|secret|clientSecret|accessToken|refreshToken)$/i.test(k) && typeof v === 'string') {
          result[k] = '[REDACTED]';
        } else if (filePathHint && this.isDotEnvPath(filePathHint) && (k === 'content' || k === 'body' || k === 'diff' || k === 'patch')) {
          result[k] = '[REDACTED:.ENV_BODY]';
        } else {
          result[k] = this.redactValue(v);
        }
      }
      return result as T;
    }
    return value;
  }

  private redactCredentialPaths(input: string): string {
    let out = input;
    // Match Unix (/home/user/..., /Users/user/..., ~/...) or Windows (C:\Users\user\...) paths containing sensitive dirs
    const pathRegex = /(?:[A-Za-z]:\\[^\s"'`<>|]+|~\/[^\s"'`<>|]+|\/(?:home|Users|root)\/[^\s"'`<>|]+)/g;
    out = out.replace(pathRegex, (matchedPath) => {
      const lower = matchedPath.toLowerCase();
      for (const dir of this.sensitiveDirs) {
        if (lower.includes(dir.toLowerCase())) {
          return `[REDACTED:CREDENTIAL_PATH/${dir.replace(/\\/g, '/')}]`;
        }
      }
      return matchedPath;
    });
    return out;
  }
}

export const defaultRedactor = new Redactor();
