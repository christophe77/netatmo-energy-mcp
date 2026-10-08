import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  currentWindowsSid,
  describeWindowsAcl,
  ensureSecureDir,
} from '../../../src/auth/secure-fs.js';
import { silentLogger } from '../../../src/utils/logger.js';

describe.runIf(process.platform === 'win32')('Windows ACL hardening', () => {
  it('restricts a new config directory to the current user and SYSTEM', async () => {
    const parent = await fs.mkdtemp(path.join(tmpdir(), 'nem-acl-'));
    const dir = path.join(parent, 'cfg');
    try {
      const result = await ensureSecureDir(dir, silentLogger);
      expect(result).toEqual({ created: true, aclRestricted: true });
      const acl = describeWindowsAcl(dir) ?? '';
      expect(currentWindowsSid()).toMatch(/^S-1-5-/);
      // No inherited entries and no broad groups.
      expect(acl).not.toMatch(/\(I\)/);
      // Exactly two entries: the current user and SYSTEM (locale-independent check).
      expect(acl.match(/:\(/g)).toHaveLength(2);
      expect(acl).toMatch(/SYSTEM|AUTORITE NT|NT AUTHORITY/i);
      // Files created inside inherit the restricted ACL.
      await fs.writeFile(path.join(dir, 'f'), 'x');
      expect((describeWindowsAcl(path.join(dir, 'f')) ?? '').match(/:\(/g)).toHaveLength(2);
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});
