import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  currentWindowsSid,
  describeWindowsAcl,
  ensureSecureDir,
  windowsAclPrincipals,
} from '../../../src/auth/secure-fs.js';
import { silentLogger } from '../../../src/utils/logger.js';

describe.runIf(process.platform === 'win32')('Windows ACL hardening', () => {
  it('restricts a new config directory to the current user and SYSTEM', async () => {
    const parent = await fs.mkdtemp(path.join(tmpdir(), 'nem-acl-'));
    const dir = path.join(parent, 'cfg');
    try {
      const result = await ensureSecureDir(dir, silentLogger);
      expect(result).toEqual({ created: true, aclRestricted: true });
      expect(currentWindowsSid()).toMatch(/^S-1-5-/);
      const acl = describeWindowsAcl(dir) ?? '';
      // No inherited entries.
      expect(acl, acl).not.toMatch(/\(I\)/);
      // Two principals: the current user and SYSTEM (locale-independent check).
      const principals = windowsAclPrincipals(dir) ?? [];
      expect(principals, acl).toHaveLength(2);
      expect(principals.join(' '), acl).toMatch(/SYSTEM|Syst|AUTORITE NT|NT AUTHORITY/i);
      // Files created inside inherit the restricted ACL.
      const file = path.join(dir, 'f');
      await fs.writeFile(file, 'x');
      expect(windowsAclPrincipals(file), describeWindowsAcl(file)).toHaveLength(2);
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});
