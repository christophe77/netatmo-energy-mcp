import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  broadWindowsPrincipals,
  currentWindowsSid,
  describeWindowsAcl,
  ensureSecureDir,
  windowsAclPrincipals,
} from '../../../src/auth/secure-fs.js';
import { silentLogger } from '../../../src/utils/logger.js';

describe('broadWindowsPrincipals', () => {
  it('flags broad groups in English and French, but not the user, SYSTEM or Administrators', () => {
    expect(
      broadWindowsPrincipals([
        'BUILTIN\\Users',
        'BUILTIN\\Utilisateurs',
        'Everyone',
        'Tout le monde',
        'NT AUTHORITY\\Authenticated Users',
        'BUILTIN\\Administrators',
        'NT AUTHORITY\\SYSTEM',
        'PC\\alice',
      ]),
    ).toEqual([
      'BUILTIN\\Users',
      'BUILTIN\\Utilisateurs',
      'Everyone',
      'Tout le monde',
      'NT AUTHORITY\\Authenticated Users',
    ]);
  });
});

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
      // The current user and SYSTEM; an elevated process also keeps Administrators.
      const principals = windowsAclPrincipals(dir) ?? [];
      expect(principals.length, acl).toBeGreaterThanOrEqual(2);
      expect(principals.length, acl).toBeLessThanOrEqual(3);
      expect(principals.join(' '), acl).toMatch(/SYSTEM|Syst|AUTORITE NT|NT AUTHORITY/i);
      expect(broadWindowsPrincipals(principals), acl).toEqual([]);
      // Files created inside inherit the restricted ACL.
      const file = path.join(dir, 'f');
      await fs.writeFile(file, 'x');
      const filePrincipals = windowsAclPrincipals(file) ?? [];
      expect(broadWindowsPrincipals(filePrincipals), describeWindowsAcl(file)).toEqual([]);
      expect(filePrincipals).toHaveLength(principals.length);
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});
